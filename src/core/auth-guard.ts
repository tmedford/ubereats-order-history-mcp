/**
 * Sign-in guard: make sure the browser is signed in before a tool runs, and repair it from
 * Chrome's cookies when it is not.
 *
 * Ported from tmedford/amazon-order-history-csv-download-mcp. The lesson it encodes: a
 * connector that imports cookies only once goes silently stale - the old session cookie is
 * still "present", import never runs again, and every call returns an empty success that is
 * indistinguishable from "no orders". So the guard:
 *   1. checks sign-in (trusted for ttlMs after a success, so a batch of calls stays cheap);
 *   2. when signed out, re-imports Chrome's cookies and checks again, with backoff;
 *   3. returns a TYPED failure the caller turns into a real error - never an empty success.
 *
 * Browser access is injected, so the retry logic is unit-tested without a browser.
 */

export interface SignInCheck {
  authenticated: boolean;
  message?: string;
}

export interface AuthGuardDeps {
  /** Ask the service whether this session is signed in. */
  check(): Promise<SignInCheck>;
  /** Copy Chrome's cookies into the browser; returns how many. */
  reimport(): Promise<number>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface AuthGuardOptions {
  /** How long a successful check is trusted. */
  ttlMs: number;
  /** Wait before each re-check after a re-import; its length is the retry count. */
  backoffMs: number[];
}

export type EnsureResult =
  | { ok: true; repaired: boolean; attempts: number }
  | { ok: false; code: "NOT_SIGNED_IN"; message: string; attempts: number };

export const DEFAULT_AUTH_GUARD_OPTIONS: AuthGuardOptions = {
  ttlMs: 5 * 60_000,
  backoffMs: [1_000, 3_000, 10_000],
};

export const NOT_SIGNED_IN_HELP =
  "Open https://www.ubereats.com in Google Chrome and sign in - this connector reuses Chrome's " +
  "session and never asks for a password. If you are signed in there, quit and reopen Chrome " +
  "once so it writes its cookies to disk, then retry.";

export class AuthGuard {
  private trustedUntil = 0;
  private inFlight: Promise<EnsureResult> | null = null;

  constructor(
    private readonly deps: AuthGuardDeps,
    private readonly opts: AuthGuardOptions = DEFAULT_AUTH_GUARD_OPTIONS,
  ) {}

  /** Forget the cached success - call when a result suggests the session died. */
  invalidate(): void {
    this.trustedUntil = 0;
  }

  ensure(): Promise<EnsureResult> {
    if (this.deps.now() < this.trustedUntil) {
      return Promise.resolve({ ok: true, repaired: false, attempts: 0 });
    }
    if (!this.inFlight) {
      this.inFlight = this.run().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async safeCheck(): Promise<SignInCheck> {
    try {
      return await this.deps.check();
    } catch (e) {
      return { authenticated: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async run(): Promise<EnsureResult> {
    let status = await this.safeCheck();
    let attempts = 0;
    while (!status.authenticated && attempts < this.opts.backoffMs.length) {
      const imported = await this.deps.reimport().catch(() => 0);
      console.error(`[auth] signed out - re-imported ${imported} Chrome cookies (attempt ${attempts + 1})`);
      await this.deps.sleep(this.opts.backoffMs[attempts]);
      attempts++;
      status = await this.safeCheck();
      // Chrome has no session to give: waiting and re-importing nothing again cannot help.
      if (imported === 0) break;
    }
    if (status.authenticated) {
      this.trustedUntil = this.deps.now() + this.opts.ttlMs;
      return { ok: true, repaired: attempts > 0, attempts };
    }
    return {
      ok: false,
      code: "NOT_SIGNED_IN",
      attempts,
      message:
        `Not signed in to Uber Eats after ${attempts} cookie re-import(s)` +
        (status.message ? ` (${status.message})` : "") +
        `. ${NOT_SIGNED_IN_HELP}`,
    };
  }
}
