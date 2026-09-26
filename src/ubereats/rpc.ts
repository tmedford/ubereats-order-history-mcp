/**
 * Uber Eats' web app talks to its backend through one RPC shape:
 *
 *   POST https://www.ubereats.com/_p/api/<operation>?localeCode=en-US
 *   headers: content-type: application/json, x-csrf-token: x
 *   body:    JSON
 *   reply:   200 {"status":"success","data":{...}}  |  200 {"status":"failure","data":{"message","code"}}
 *
 * This is the page's own data source - the order list and receipt pages render from it -
 * so reading it is exact where scraping the rendered page would be lossy. The session is
 * the cookie jar (sid, jwt-session, ...); `x-csrf-token: x` is the literal value the web
 * app sends (a missing header returns 403 "Missing csrf token.").
 *
 * Requests run INSIDE a real Chrome page on www.ubereats.com (see PageTransport), so they
 * carry the browser's cookies, TLS fingerprint and Cloudflare clearance exactly as the web
 * app's own requests do.
 */

import type { Page } from "playwright-core";
import { withRetry, defaultSleep } from "../core/retry";
import type { SharedBrowser } from "../core/shared-browser";

export const UBEREATS_ORIGIN = "https://www.ubereats.com";

export interface RpcResponse {
  status: number;
  text: string;
}

export interface RpcTransport {
  post(operation: string, body: unknown): Promise<RpcResponse>;
  /** Drop any cached page/state; the next post starts fresh (after a bot challenge). */
  reset?(): Promise<void>;
}

export type UberEatsErrorCode =
  "NOT_SIGNED_IN" | "BOT_CHALLENGE" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "CSRF_REJECTED" | "API_ERROR";

/**
 * THE ONLY OPERATIONS THIS SERVER MAY EVER CALL - all reads. Enforced in UberEatsRpc before
 * any request is made, so a bug or a crafted tool argument cannot reach an Uber Eats
 * operation that changes state (orders, carts, tips, ratings, payment methods).
 */
export const ALLOWED_OPERATIONS: ReadonlySet<string> = new Set([
  "getPastOrdersV1",
  "getPastOrderV1",
  "getReceiptByWorkflowUuidV1",
]);

/** Origins the automation page may talk to; everything else is aborted. */
export function isAllowedRequestUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "ubereats.com" || u.hostname.endsWith(".ubereats.com"));
  } catch {
    return false;
  }
}

/** Keep error text short and free of anything token-shaped before it reaches a client. */
export function sanitizeSnippet(text: string, max = 160): string {
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "<hex>")
    .replace(/[\w-]{40,}/g, "<token>")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

/** An upstream error code is shown only when it is a short, plain identifier. */
function safeCode(code: unknown): string {
  if (code === undefined || code === null) return "";
  const c = String(code);
  return /^[\w.-]{1,32}$/.test(c) ? ` (code ${c})` : "";
}

export class UberEatsError extends Error {
  constructor(
    readonly code: UberEatsErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly operation?: string,
  ) {
    super(message);
    this.name = "UberEatsError";
  }
}

/** Failures whose message means "this request has no signed-in user". */
const SIGNED_OUT =
  /missing user uuid|unauthori[sz]ed|unauthenticated|not (logged|signed) in|login required|invalid session/i;

/** Turn one raw response into its `data` payload, or throw a typed error. */
export function parseRpcResponse(operation: string, res: RpcResponse): unknown {
  const text = res.text ?? "";
  if (res.status === 401) {
    throw new UberEatsError("NOT_SIGNED_IN", `${operation}: HTTP 401`, false, operation);
  }
  if (res.status === 429) {
    throw new UberEatsError("RATE_LIMITED", `${operation}: rate limited (HTTP 429)`, true, operation);
  }
  if (res.status === 403 && /csrf/i.test(text)) {
    throw new UberEatsError("CSRF_REJECTED", `${operation}: ${sanitizeSnippet(text, 120)}`, false, operation);
  }
  if (text.trimStart().startsWith("<")) {
    // An HTML body on an RPC route is Cloudflare's challenge/block page, not an answer.
    throw new UberEatsError(
      "BOT_CHALLENGE",
      `${operation}: got an HTML page (HTTP ${res.status}) instead of JSON - bot challenge`,
      true,
      operation,
    );
  }
  if (res.status >= 500) {
    throw new UberEatsError("UPSTREAM_ERROR", `${operation}: HTTP ${res.status}`, true, operation);
  }
  let json: { status?: string; data?: { message?: string; code?: unknown } & Record<string, unknown> };
  try {
    json = JSON.parse(text);
  } catch {
    throw new UberEatsError(
      "UPSTREAM_ERROR",
      `${operation}: unparseable response (HTTP ${res.status}): ${sanitizeSnippet(text, 120)}`,
      true,
      operation,
    );
  }
  if (json.status === "success") return json.data ?? {};
  const message = sanitizeSnippet(String(json.data?.message ?? `HTTP ${res.status}`), 300);
  if (SIGNED_OUT.test(message)) {
    throw new UberEatsError("NOT_SIGNED_IN", `${operation}: ${message}`, false, operation);
  }
  throw new UberEatsError(
    "API_ERROR",
    sanitizeSnippet(`${operation} failed: ${message}${safeCode(json.data?.code)}`, 360),
    false,
    operation,
  );
}

export interface RpcOptions {
  backoffMs?: number[];
  sleep?(ms: number): Promise<void>;
}

export class UberEatsRpc {
  constructor(
    private readonly transport: RpcTransport,
    private readonly opts: RpcOptions = {},
  ) {}

  call<T = unknown>(operation: string, body: unknown): Promise<T> {
    if (!ALLOWED_OPERATIONS.has(operation)) {
      return Promise.reject(
        new UberEatsError(
          "API_ERROR",
          `operation ${JSON.stringify(operation)} is not on the read-only allowlist`,
          false,
        ),
      );
    }
    return withRetry(async () => parseRpcResponse(operation, await this.postSafely(operation, body)) as T, {
      backoffMs: this.opts.backoffMs ?? [500, 2_000, 5_000],
      sleep: this.opts.sleep ?? defaultSleep,
      isRetryable: (e) => e instanceof UberEatsError && e.retryable,
      onRetry: async (e, attempt) => {
        console.error(`[rpc] ${operation} retry ${attempt}: ${e instanceof Error ? e.message : e}`);
        if (e instanceof UberEatsError && e.code === "BOT_CHALLENGE") await this.transport.reset?.();
      },
    });
  }

  private async postSafely(operation: string, body: unknown): Promise<RpcResponse> {
    try {
      return await this.transport.post(operation, body);
    } catch (e) {
      // a crashed/closed page or a dropped connection - worth one more try on a fresh page
      await this.transport.reset?.().catch(() => undefined);
      throw new UberEatsError(
        "UPSTREAM_ERROR",
        `${operation}: transport failed: ${sanitizeSnippet(e instanceof Error ? e.message : String(e))}`,
        true,
        operation,
      );
    }
  }
}

/**
 * Runs RPCs with fetch() inside a page on www.ubereats.com.
 *
 * The page only needs the ORIGIN, not the app: it loads /robots.txt (a few hundred bytes,
 * no scripts, no images) and every call after that is a same-origin fetch - no page
 * scraping, no rendering, no navigation per request.
 */
export class PageTransport implements RpcTransport {
  private page: Page | null = null;
  private warming: Promise<Page> | null = null;

  constructor(
    private readonly browser: SharedBrowser,
    private readonly locale = process.env.UBEREATS_LOCALE ?? "en-US",
    private readonly origin = UBEREATS_ORIGIN,
  ) {}

  async post(operation: string, body: unknown): Promise<RpcResponse> {
    const page = await this.ensurePage();
    return page.evaluate(
      async ({ op, payload, locale }) => {
        const r = await fetch(`/_p/api/${op}?localeCode=${encodeURIComponent(locale)}`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "x-csrf-token": "x" },
          body: JSON.stringify(payload),
        });
        return { status: r.status, text: await r.text() };
      },
      { op: operation, payload: body, locale: this.locale },
    );
  }

  async reset(): Promise<void> {
    const p = this.page;
    this.page = null;
    await p?.close().catch(() => undefined);
  }

  private ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return Promise.resolve(this.page);
    if (!this.warming) {
      this.warming = this.warm().finally(() => {
        this.warming = null;
      });
    }
    return this.warming;
  }

  private async warm(): Promise<Page> {
    const page = await this.browser.newPage();
    try {
      // This page carries the user's session: it may talk to Uber Eats and nothing else
      // (no third-party trackers, no redirects off-origin).
      await page.route("**/*", (route) =>
        isAllowedRequestUrl(route.request().url()) ? route.continue() : route.abort("blockedbyclient"),
      );
      await page.goto(`${this.origin}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (!isAllowedRequestUrl(page.url())) {
        throw new UberEatsError("UPSTREAM_ERROR", "the Uber Eats origin redirected off-site; refusing to use it", true);
      }
    } catch (e) {
      await page.close().catch(() => undefined);
      throw e;
    }
    this.page = page;
    return page;
  }
}
