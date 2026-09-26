import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OwnerLock, pidAlive } from "../../../src/core/shared-browser";

let dir: string;
let lockFile: string;
let endpointFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owner-lock-"));
  lockFile = join(dir, "profile.owner.lock");
  endpointFile = join(dir, "DevToolsActivePort");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const age = (file: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
};

describe("OwnerLock", () => {
  test("first acquirer wins; a second instance cannot take a live lock", () => {
    const a = new OwnerLock(lockFile, endpointFile, 15_000, 60_000);
    const b = new OwnerLock(lockFile, endpointFile, 15_000, 60_000);
    expect(a.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    expect(a.owner()?.pid).toBe(process.pid);
    a.release();
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a lock held by a dead pid is cleared so the next attempt wins", () => {
    writeFileSync(lockFile, "999999"); // not a running process
    const l = new OwnerLock(lockFile, endpointFile);
    expect(l.tryAcquire()).toBe(false); // clears the stale lock
    expect(l.tryAcquire()).toBe(true);
    l.release();
  });

  test("a live pid that stopped refreshing, with no browser answering, is stale", () => {
    writeFileSync(lockFile, String(process.ppid)); // alive, but not us
    age(lockFile, 60_000);
    const l = new OwnerLock(lockFile, endpointFile, 15_000);
    expect(l.tryAcquire()).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("unlinkIfStale only removes the named owner's lock after the grace period", () => {
    writeFileSync(lockFile, "4242");
    const l = new OwnerLock(lockFile, endpointFile, 15_000);
    l.unlinkIfStale(4242); // fresh - kept
    expect(existsSync(lockFile)).toBe(true);
    age(lockFile, 20_000);
    l.unlinkIfStale(1111); // someone else's - kept
    expect(existsSync(lockFile)).toBe(true);
    l.unlinkIfStale(4242);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("endpoint is read only from a well-formed DevToolsActivePort", () => {
    const l = new OwnerLock(lockFile, endpointFile);
    expect(l.endpoint()).toBeNull();
    writeFileSync(endpointFile, "9222\n/devtools/browser/abc-123\n");
    expect(l.endpoint()).toBe("ws://127.0.0.1:9222/devtools/browser/abc-123");
    writeFileSync(endpointFile, "9222\n/json/version\n");
    expect(l.endpoint()).toBeNull();
    writeFileSync(endpointFile, "http://evil\n/devtools/browser/x\n");
    expect(l.endpoint()).toBeNull();
  });

  test("release never deletes another process's lock", () => {
    const l = new OwnerLock(lockFile, endpointFile);
    expect(l.tryAcquire()).toBe(true);
    writeFileSync(lockFile, "4242"); // taken over while we were away
    l.release();
    expect(existsSync(lockFile)).toBe(true);
  });
});

test("pidAlive", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(999999)).toBe(false);
  expect(pidAlive(-1)).toBe(false);
  expect(pidAlive(NaN)).toBe(false);
});
