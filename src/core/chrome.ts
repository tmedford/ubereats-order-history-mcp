/**
 * The installed Google Chrome: where it is, which version, and the user agent it sends.
 *
 * WHY THIS MATTERS: the imported cookies belong to the installed Chrome, and sites tie a
 * session to the browser that holds it. In the Amazon connector a fixed "Chrome/120" user
 * agent carrying Chrome 153's cookies was sent to the password page, while "Chrome/153" got
 * the orders page - same cookies, same minute. Uber Eats' WAF also rejects Playwright's
 * bundled Chromium outright. So this connector drives the REAL installed Chrome (always the
 * latest the user has) and presents its real version.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";

export const DEFAULT_CHROME_APP = "/Applications/Google Chrome.app";

/** Path to the Chrome binary: UBEREATS_CHROME_PATH, else the standard macOS install. */
export function chromeExecutablePath(): string | undefined {
  const override = process.env.UBEREATS_CHROME_PATH;
  if (override) return override;
  const p = `${DEFAULT_CHROME_APP}/Contents/MacOS/Google Chrome`;
  return fs.existsSync(p) ? p : undefined;
}

/** Installed Chrome version ("153.0.8010.53"), or undefined when it cannot be read. */
export function installedChromeVersion(app = DEFAULT_CHROME_APP): string | undefined {
  try {
    const v = execFileSync("defaults", ["read", `${app}/Contents/Info`, "CFBundleShortVersionString"], {
      timeout: 5000,
    })
      .toString()
      .trim();
    return /^\d+\./.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The desktop Chrome user agent for a given version (reduced UA: minor parts are zeroed). */
export function chromeUserAgent(version = installedChromeVersion()): string {
  const major = version?.split(".")[0] ?? "140";
  return (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/${major}.0.0.0 Safari/537.36`
  );
}
