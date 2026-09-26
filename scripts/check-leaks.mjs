#!/usr/bin/env node
/**
 * Fails (exit 1) if any tracked file contains something that looks like personal data or a
 * credential. Runs in CI on every push and pull request, and locally via `npm run check:leaks`.
 *
 * It cannot know YOUR name or address, so it checks shapes instead: only the fixtures'
 * placeholder identities may appear; card numbers must be the repeated-digit fakes; no
 * emails, phone numbers, JWTs, session cookies or long tokens anywhere.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !/\.(png|jpg|jpeg|gif|ico)$/i.test(f)); // the lockfile IS scanned (tokens in registry URLs)

const ALLOWED_EMAILS = /@(example\.com|users\.noreply\.github\.com)$/i;
const RULES = [
  {
    name: "email address",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    ok: (m) => ALLOWED_EMAILS.test(m),
  },
  {
    name: "phone number",
    re: /(?<![\w.-])\+?1?[ .(-]*\d{3}[ .)-]+\d{3}[ .-]\d{4}(?![\w-])/g,
    ok: (m) => /555[ .-]?01\d\d/.test(m),
  },
  {
    name: "card number (not a repeated-digit fake)",
    re: /(?:••••|\*{4}|x{4}|ending in )\s?(\d{4})/gi,
    ok: (m) => /(\d)\1{3}$/.test(m) || /1234|5678|0000/.test(m),
  },
  {
    name: "credentials in a URL",
    re: /(?:https?:)?\/\/[^\s/"'@:]+:[^\s/"'@]+@[\w.-]+|_auth(?:Token)?["']?\s*[=:]\s*["']?[\w+/=.-]{8,}/g,
    ok: () => false,
    credential: true,
  },
  { name: "JWT", re: /eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g, ok: () => false, credential: true },
  { name: "session cookie value", re: /\b(sid|jwt-session|csid)=[\w.%-]{16,}/g, ok: () => false, credential: true },
  {
    name: "GitHub/API token",
    re: /\b(ghp|gho|ghs|github_pat|sk-ant|sk|npm)_[A-Za-z0-9_]{20,}/g,
    ok: () => false,
    credential: true,
  },
  {
    name: "non-placeholder person on a receipt",
    re: /(Thanks for (?:ordering|tipping), |(?:Delivered|Picked up) by )([A-Z][A-Za-z'-]+)/g,
    ok: (m) => /(, |by )Alex$/.test(m),
  },
];

let bad = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (f === "scripts/check-leaks.mjs") continue; // this file describes the patterns
  // The lockfile lists public package metadata (maintainer emails etc.): only the
  // credential rules apply there - a token in a registry URL is exactly what to catch.
  const rules = f === "package-lock.json" ? RULES.filter((r) => r.credential) : RULES;
  for (const rule of rules) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.ok(m[0])) continue;
      bad++;
      const line = text.slice(0, m.index).split("\n").length;
      console.error(`LEAK? ${f}:${line}: ${rule.name}: ${m[0].slice(0, 6)}…`);
    }
  }
}
if (bad) {
  console.error(`\n${bad} possible leak(s). Scrub them (scripts/scrub-fixtures.mjs) before pushing.`);
  process.exit(1);
}
console.log(`check-leaks: ${files.length} tracked files clean`);
