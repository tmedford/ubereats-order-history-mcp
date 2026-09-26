#!/usr/bin/env node
/**
 * ubereats-order-history-mcp - read-only MCP server for your Uber Eats order history.
 *
 * Signed in with the session your Chrome already has (cookies copied from Chrome every time
 * the browser opens and whenever a call finds the session gone), driving the real installed
 * Chrome, reading Uber Eats' own JSON/receipt feeds instead of scraping rendered pages.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserContext } from "playwright-core";
import { homedir } from "os";
import { join } from "path";
import { AuthGuard, EnsureResult } from "./core/auth-guard";
import { importChromeCookies } from "./core/chrome-cookies";
import { chromeExecutablePath, chromeUserAgent, installedChromeVersion } from "./core/chrome";
import { SharedBrowser } from "./core/shared-browser";
import { UberEatsClient } from "./ubereats/client";
import { PageTransport, UberEatsError, UberEatsRpc } from "./ubereats/rpc";
import { handleTool, InputError, TOOLS } from "./tools/handlers";

const VERSION = "0.1.0";

/** Cookie domains that carry the Uber Eats session (auth is shared with uber.com). */
export const SESSION_DOMAINS = ["ubereats.com", "uber.com"];
const DOMAIN_RE = /(^|\.)(ubereats|uber)\.com$/;

const DATA_DIR =
  process.env.UBEREATS_ORDERS_BROWSER_DATA_DIR ?? join(homedir(), ".ubereats-order-history-mcp", "browser-data");
// Headless by default: the session comes from Chrome, so no window is ever needed to sign
// in. UBEREATS_ORDERS_HEADFUL=1 shows the window (debugging only).
const HEADLESS = process.env.UBEREATS_ORDERS_HEADFUL !== "1";
const chromeVersion = installedChromeVersion();

/**
 * EVERY TIME THE BROWSER OPENS - owner or attached - Chrome's session replaces this
 * profile's. The profile persists on disk, so its own copy of a session goes stale while
 * Chrome (where the user actually stays signed in) keeps a fresh one. Cleared only once
 * Chrome has cookies to give, so a failed import never leaves the browser with none.
 */
async function importSession(context: BrowserContext): Promise<number> {
  const { cookies } = importChromeCookies(SESSION_DOMAINS);
  if (cookies.length === 0) {
    console.error("[browser] Chrome had no Uber Eats cookies to import.");
    return 0;
  }
  await context.clearCookies({ domain: DOMAIN_RE });
  await context.addCookies(cookies);
  console.error(`[browser] Imported ${cookies.length} Uber session cookies from Chrome.`);
  return cookies.length;
}

const browser = new SharedBrowser({
  dataDir: DATA_DIR,
  headless: HEADLESS,
  userAgent: chromeUserAgent(chromeVersion),
  executablePath: chromeExecutablePath(),
  onOpen: async (ctx) => {
    await importSession(ctx);
  },
});
const transport = new PageTransport(browser);
const client = new UberEatsClient(new UberEatsRpc(transport));

const guard = new AuthGuard({
  check: () => client.checkSignedIn(),
  reimport: async () => {
    const n = await importSession(await browser.getContext());
    await transport.reset(); // next RPC starts on a page that carries the new cookies
    return n;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});

function reply(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError } : {}),
  };
}

function signInError(r: Extract<EnsureResult, { ok: false }>) {
  return reply({ status: "error", error: r.code, message: r.message, attempts: r.attempts }, true);
}

function errorReply(e: unknown) {
  if (e instanceof InputError) return reply({ status: "error", error: "INVALID_INPUT", message: e.message }, true);
  if (e instanceof UberEatsError) return reply({ status: "error", error: e.code, message: e.message }, true);
  return reply({ status: "error", error: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) }, true);
}

const server = new Server({ name: "ubereats-order-history-mcp", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const run = () => handleTool(name, args, client, { chromeVersion });
  try {
    if (name === "check_ubereats_auth_status") {
      // report, but still repair: a signed-out answer triggers one cookie re-import first
      const r = await guard.ensure();
      if (!r.ok) return reply({ status: "success", authenticated: false, message: r.message, chromeVersion });
      return reply(await run());
    }
    const before = await guard.ensure();
    if (!before.ok) return signInError(before);
    try {
      return reply(await run());
    } catch (e) {
      // the session can die mid-call: repair from Chrome and try the call once more
      if (!(e instanceof UberEatsError && e.code === "NOT_SIGNED_IN")) throw e;
      guard.invalidate();
      const after = await guard.ensure();
      if (!after.ok) return signInError(after);
      return reply(await run());
    }
  } catch (e) {
    return errorReply(e);
  }
});

async function shutdown(): Promise<void> {
  await browser.shutdown();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`ubereats-order-history-mcp ${VERSION} running (Chrome ${chromeVersion ?? "unknown"})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
