/**
 * ONE BROWSER, MANY SERVERS.
 *
 * Every Claude session that has this MCP configured spawns its own copy of the server, and
 * they all share one browser profile directory - which Chrome locks. Ported from
 * tmedford/amazon-order-history-csv-download-mcp, where four servers meant one owned the
 * browser and the rest failed or hung:
 *
 *  - The first server takes an O_EXCL lockfile and launches Chrome with
 *    --remote-debugging-port=0. Chrome writes the chosen port and a per-run browser id to
 *    <profile>/DevToolsActivePort.
 *  - Every other server reads that file and attaches over CDP - only while the lock owner
 *    is alive, so a server never attaches to whatever else listens on a guessable port
 *    (which would be handed decrypted session cookies).
 *  - The owner refreshes its lock every few seconds; a lock that stopped refreshing and has
 *    no browser answering is stale and is taken over (pids get reused after a reboot).
 *  - Concurrent opens inside one server share a single in-flight promise.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import { chmodSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

export interface SharedBrowserOptions {
  /** Persistent profile directory owned by this connector (never Chrome's own profile). */
  dataDir: string;
  headless: boolean;
  userAgent: string;
  /** Chrome binary; undefined lets Playwright use the "chrome" channel. */
  executablePath?: string;
  /** Runs on every open (owner or attached) - e.g. import Chrome's cookies. */
  onOpen?(context: BrowserContext): Promise<void>;
  /** How long an owner may go without refreshing its lock before it is stale. */
  lockGraceMs?: number;
  heartbeatMs?: number;
  openTimeoutMs?: number;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to another user - alive, not stale
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The lockfile half, separated from Playwright so it can be tested on a temp directory.
 */
export class OwnerLock {
  private held = false;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    readonly lockFile: string,
    readonly endpointFile: string,
    private readonly graceMs = 15_000,
    private readonly heartbeatMs = 5_000,
  ) {}

  get holds(): boolean {
    return this.held;
  }

  owner(): { pid: number; ageMs: number } | null {
    try {
      const pid = parseInt(readFileSync(this.lockFile, "utf8"), 10);
      return { pid, ageMs: Date.now() - statSync(this.lockFile).mtimeMs };
    } catch {
      return null;
    }
  }

  /** ws:// endpoint of the browser this profile's owner launched, or null. */
  endpoint(): string | null {
    try {
      const [port, path] = readFileSync(this.endpointFile, "utf8").split("\n");
      if (!/^\d+$/.test(port?.trim() ?? "") || !path?.trim().startsWith("/devtools/browser/")) return null;
      return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    } catch {
      return null;
    }
  }

  tryAcquire(): boolean {
    try {
      mkdirSync(dirname(this.lockFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
      this.held = true;
      this.startHeartbeat();
      return true;
    } catch {
      const o = this.owner();
      if (!o) return false; // vanished between the two reads - the next loop retries
      // Stale if the owner died, OR it is alive but stopped refreshing and no browser
      // answers - after a reboot the old pid is often reused by an unrelated process.
      if (!pidAlive(o.pid) || (o.ageMs > this.graceMs && !this.endpoint())) {
        this.unlinkQuietly();
      }
      return false;
    }
  }

  /** Remove the lock only if it still belongs to `pid` and has stopped refreshing. */
  unlinkIfStale(pid: number): void {
    const o = this.owner();
    if (!o || o.pid !== pid || o.ageMs <= this.graceMs) return;
    this.unlinkQuietly();
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    try {
      if (parseInt(readFileSync(this.lockFile, "utf8"), 10) === process.pid) unlinkSync(this.lockFile);
    } catch {
      /* already gone */
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(this.lockFile, now, now);
      } catch {
        /* lock gone - the next open re-elects */
      }
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  private unlinkQuietly(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      /* someone else already cleaned it */
    }
  }
}

/**
 * The connector's profile holds the imported Uber session cookies on disk: owner-only,
 * like Chrome's own profile. Tightened on every launch in case it was created looser.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const parent = dirname(dir);
  try {
    if ((statSync(parent).mode & 0o077) !== 0 && parent.endsWith(".ubereats-order-history-mcp"))
      chmodSync(parent, 0o700);
  } catch {
    /* parent not ours - leave it */
  }
}

export class SharedBrowser {
  private context: BrowserContext | null = null;
  private attached: Browser | null = null;
  private opening: Promise<BrowserContext> | null = null;
  readonly lock: OwnerLock;

  constructor(private readonly opts: SharedBrowserOptions) {
    this.lock = new OwnerLock(
      `${opts.dataDir}.owner.lock`,
      join(opts.dataDir, "DevToolsActivePort"),
      opts.lockGraceMs,
      opts.heartbeatMs,
    );
    process.on("exit", () => this.lock.release());
  }

  /** The shared browser context, opening or attaching on first use. */
  getContext(): Promise<BrowserContext> {
    if (this.context) return Promise.resolve(this.context);
    if (!this.opening) {
      this.opening = this.open()
        .then((ctx) => (this.context = ctx))
        .finally(() => {
          this.opening = null;
        });
    }
    return this.opening;
  }

  /** A fresh page in the shared context; relaunches once if the context died silently. */
  async newPage(): Promise<Page> {
    try {
      return await (await this.getContext()).newPage();
    } catch (e) {
      console.error(`[browser] Reopening after error: ${e instanceof Error ? e.message : e}`);
      this.forget();
      return (await this.getContext()).newPage();
    }
  }

  /** The owner closes the browser; an attached server only disconnects. */
  async shutdown(): Promise<void> {
    try {
      if (this.attached) await this.attached.close();
      else if (this.context) await this.context.close();
    } catch {
      /* already gone */
    }
    this.forget();
  }

  private forget(ctx?: BrowserContext): void {
    if (ctx && this.context && ctx !== this.context) return;
    this.context = null;
    this.attached = null;
    this.lock.release();
  }

  private async open(): Promise<BrowserContext> {
    const deadline = Date.now() + (this.opts.openTimeoutMs ?? 60_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      const owner = this.lock.owner();
      const endpoint = owner && owner.pid !== process.pid && pidAlive(owner.pid) ? this.lock.endpoint() : null;
      if (endpoint && owner) {
        try {
          const browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 });
          const context = browser.contexts()[0];
          if (context) {
            this.attached = browser;
            browser.on("disconnected", () => this.forget(context));
            console.error(`[browser] Attached to the shared browser (owner pid ${owner.pid})`);
            await this.opts.onOpen?.(context);
            return context;
          }
          await browser.close();
        } catch (e) {
          lastError = e; // stale DevToolsActivePort, or the owner is still starting
          this.lock.unlinkIfStale(owner.pid);
        }
      }
      if (this.lock.tryAcquire()) {
        try {
          ensurePrivateDir(this.opts.dataDir);
          const context = await chromium.launchPersistentContext(this.opts.dataDir, {
            headless: this.opts.headless,
            ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : { channel: "chrome" }),
            userAgent: this.opts.userAgent,
            viewport: { width: 1280, height: 800 },
            args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
          });
          this.attached = null;
          context.on("close", () => this.forget(context));
          console.error(`[browser] Launched the shared browser (profile ${this.opts.dataDir})`);
          await this.opts.onOpen?.(context);
          return context;
        } catch (e) {
          lastError = e;
          this.lock.release();
        }
      }
      if (!lastError) {
        const o = this.lock.owner();
        lastError = o ? `lock held by pid ${o.pid} for ${Math.round(o.ageMs / 1000)}s` : "no owner";
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`could not open or attach to the browser: ${String(lastError)}`);
  }
}
