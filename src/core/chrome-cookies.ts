/**
 * Copy Chrome's Cookies database and decrypt the cookies for a set of domains.
 *
 * Ported from tmedford/amazon-order-history-csv-download-mcp (MIT, itself a fork of
 * marcusquinn/amazon-order-history-csv-download-mcp), generalised from "amazon.com only"
 * to any list of registrable domains. macOS + Chrome only - the Keychain read below is
 * the platform-specific part.
 *
 * Cryptographic constants are fixed by Chromium's cookie format:
 * - salt "saltysalt"; AES-128-CBC; IV = 16 space bytes.
 * - PBKDF2-HMAC-SHA1, 1003 iterations on macOS, key length 16.
 * - v10/v11 prefixes are 3 bytes. Store version >= 24 prepends a 32-byte
 *   SHA256(host_key) digest inside the plaintext (decrypt -> unpad -> strip 32).
 * - v20 is Chrome's app-bound encryption and needs OS elevation; it is skipped,
 *   never attempted - a refusal, not a bypass.
 *
 * The macOS Keychain read (`security find-generic-password`) is the consent gate: macOS
 * may prompt the user the first time. Nothing here reads or stores a password - only
 * the already-authenticated session cookies for the requested domains.
 *
 * Decrypted cookie VALUES are never logged - only counts. The Keychain "Safe Storage"
 * secret is Chrome's master cookie key (all sites), held in memory only for the duration
 * of one call; only the requested domains' cookies are ever decrypted or returned.
 */

import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ImportedCookie {
  name: string;
  value: string; // decrypted plaintext - callers must never log this
  domain: string;
  path: string;
  expires: number; // unix seconds; -1 for a session cookie (Playwright's sentinel)
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export class V20EncryptedError extends Error {}
export class KeystoreUnavailableError extends Error {}

const SALT = "saltysalt";
const CBC_IV = Buffer.alloc(16, " ");
const KEY_LENGTH = 16;
const MACOS_ITERATIONS = 1003;
const HOST_KEY_PREFIX_LEN = 32;
const HOST_KEY_PREFIX_MIN_VERSION = 24;
const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600;

const SAMESITE_MAP: Record<number, "Strict" | "Lax" | "None"> = {
  [-1]: "Lax",
  0: "None",
  1: "Lax",
  2: "Strict",
};

/** Run a read-only query through the system sqlite3 CLI (ships with macOS) as JSON. */
function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString()
    .trim();
  if (!out) return []; // sqlite3 -json prints nothing for zero rows
  return JSON.parse(out) as T[];
}

/** Chrome profile directory: UBEREATS_CHROME_PROFILE_DIR, else ~/Library/.../Chrome/<profile>. */
export function chromeProfileDir(profile = process.env.UBEREATS_CHROME_PROFILE ?? "Default"): string {
  return (
    process.env.UBEREATS_CHROME_PROFILE_DIR ??
    path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", profile)
  );
}

function macosSafeStoragePassword(account = "Chrome", service = "Chrome Safe Storage"): Buffer {
  const attempts: string[][] = [
    ["find-generic-password", "-a", account, "-w"],
    ["find-generic-password", "-a", account, "-s", service, "-w"],
  ];
  let lastError: unknown;
  for (const args of attempts) {
    try {
      const out = execFileSync("security", args, { timeout: 10_000 });
      return Buffer.from(out.toString().replace(/\n$/, ""), "utf8");
    } catch (e) {
      lastError = e instanceof Error ? e.message : "unknown error";
    }
  }
  throw new KeystoreUnavailableError(
    `macOS keychain has no "${service}" key (Chrome may never have been run). Last error: ${String(lastError)}`,
  );
}

export function deriveCbcKey(password: Buffer, iterations = MACOS_ITERATIONS): Buffer {
  return crypto.pbkdf2Sync(password, SALT, iterations, KEY_LENGTH, "sha1");
}

function copyLockedDb(dbPath: string): { tempDir: string; dbCopy: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ubereats-cookie-import-"));
  try {
    fs.chmodSync(tempDir, 0o700);
    const dbCopy = path.join(tempDir, "Cookies");
    fs.copyFileSync(dbPath, dbCopy);
    fs.chmodSync(dbCopy, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(dbPath + suffix)) {
        fs.copyFileSync(dbPath + suffix, dbCopy + suffix);
        fs.chmodSync(dbCopy + suffix, 0o600);
      }
    }
    return { tempDir, dbCopy };
  } catch (e) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw e;
  }
}

function decryptPlaintext(blob: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, CBC_IV);
  return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
}

/** True when the plaintext's 32-byte prefix is SHA256(host_key) - i.e. the key is right. */
export function hostKeyPrefixMatches(blob: Buffer, key: Buffer, hostKey: string): boolean {
  try {
    const expected = crypto.createHash("sha256").update(hostKey, "utf8").digest();
    return decryptPlaintext(blob, key).subarray(0, HOST_KEY_PREFIX_LEN).equals(expected);
  } catch {
    return false;
  }
}

/** Decrypt one cookie value (or pass a plaintext value through). */
export function decryptCookieValue(
  blob: Buffer | null,
  plaintextValue: string | null,
  key: Buffer,
  storeVersion: number,
): string {
  if (plaintextValue) return plaintextValue;
  if (!blob || blob.length === 0) return "";
  const prefix = blob.subarray(0, 3).toString("latin1");
  if (prefix === "v20") {
    throw new V20EncryptedError("app-bound (v20) cookie encryption needs OS elevation; not supported");
  }
  if (prefix !== "v10" && prefix !== "v11") {
    throw new V20EncryptedError(`unsupported cookie encryption prefix ${JSON.stringify(prefix)}`);
  }
  let plaintext = decryptPlaintext(blob, key);
  if (storeVersion >= HOST_KEY_PREFIX_MIN_VERSION) plaintext = plaintext.subarray(HOST_KEY_PREFIX_LEN);
  return plaintext.toString("utf8");
}

/** Chrome stores expiry as microseconds since 1601-01-01; Playwright wants unix seconds. */
export function chromeExpiresToUnix(expiresUtc: number): number {
  if (!expiresUtc) return -1;
  return Math.floor(expiresUtc / 1_000_000 - WINDOWS_EPOCH_OFFSET_SECONDS);
}

/** host_key ".ubereats.com" / "www.ubereats.com" belong to "ubereats.com"; "notubereats.com" does not. */
export function hostMatchesDomain(hostKey: string, domain: string): boolean {
  const h = hostKey.replace(/^\./, "").toLowerCase();
  const d = domain.replace(/^\./, "").toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

export interface ImportResult {
  cookies: ImportedCookie[];
  skippedAppBound: number;
  skippedWrongKey: number;
}

/**
 * Import the cookies for `domains` from the local Chrome profile.
 * Returns an empty result (never throws) when Chrome, its cookie store, or the Keychain
 * key is unavailable - the caller reports "not signed in" instead.
 */
export function importChromeCookies(domains: string[], profileDir = chromeProfileDir()): ImportResult {
  const empty: ImportResult = { cookies: [], skippedAppBound: 0, skippedWrongKey: 0 };
  const dbPath = path.join(profileDir, "Cookies");
  if (!fs.existsSync(dbPath)) return empty;

  let key: Buffer;
  try {
    key = deriveCbcKey(macosSafeStoragePassword());
  } catch (e) {
    console.error(`[cookies] Keychain read failed, skipping import: ${e instanceof Error ? e.message : e}`);
    return empty;
  }

  let tempDir: string;
  let dbCopy: string;
  try {
    ({ tempDir, dbCopy } = copyLockedDb(dbPath));
  } catch (e) {
    console.error(`[cookies] Could not copy Chrome's cookie store: ${e instanceof Error ? e.message : e}`);
    return empty;
  }

  const result: ImportResult = { cookies: [], skippedAppBound: 0, skippedWrongKey: 0 };
  try {
    let storeVersion = 0;
    try {
      const meta = sqliteJson<{ value: string }>(dbCopy, "SELECT value FROM meta WHERE key = 'version'");
      storeVersion = meta[0]?.value ? parseInt(meta[0].value, 10) : 0;
    } catch {
      storeVersion = 0;
    }
    const cols = new Set(sqliteJson<{ name: string }>(dbCopy, "PRAGMA table_info(cookies)").map((c) => c.name));
    const secureCol = cols.has("is_secure") ? "is_secure" : "secure";
    const httpOnlyCol = cols.has("is_httponly") ? "is_httponly" : "httponly";

    // Filter in SQL: selecting every site's cookies overflows the CLI buffer on a real
    // profile and needlessly moves other sites' ciphertext through this process. The
    // domains are code constants, but they are still validated before interpolation.
    for (const d of domains) {
      if (!/^[a-z0-9.-]+$/i.test(d)) throw new Error(`invalid cookie domain ${JSON.stringify(d)}`);
    }
    const where = domains.map((d) => `host_key LIKE '%${d}'`).join(" OR ");
    const rows = sqliteJson<{
      host_key: string | null;
      name: string;
      encrypted_value_hex: string | null;
      value: string | null;
      path: string | null;
      expires_utc: number | null;
      secure_col: number;
      httponly_col: number;
      samesite: number;
    }>(
      dbCopy,
      `SELECT host_key, name, hex(encrypted_value) AS encrypted_value_hex, value, path, expires_utc, ` +
        `${secureCol} AS secure_col, ${httpOnlyCol} AS httponly_col, samesite FROM cookies WHERE ${where}`,
    );

    for (const row of rows) {
      const hostKey = row.host_key ?? "";
      if (!domains.some((d) => hostMatchesDomain(hostKey, d))) continue;
      const blob = row.encrypted_value_hex ? Buffer.from(row.encrypted_value_hex, "hex") : null;
      const prefix = blob && blob.length >= 3 ? blob.subarray(0, 3).toString("latin1") : "";
      if (
        !row.value &&
        blob &&
        (prefix === "v10" || prefix === "v11") &&
        storeVersion >= HOST_KEY_PREFIX_MIN_VERSION &&
        !hostKeyPrefixMatches(blob, key, hostKey)
      ) {
        result.skippedWrongKey++;
        continue;
      }
      let value: string;
      try {
        value = decryptCookieValue(blob, row.value, key, storeVersion);
      } catch (e) {
        if (e instanceof V20EncryptedError) result.skippedAppBound++;
        else result.skippedWrongKey++;
        continue;
      }
      result.cookies.push({
        name: row.name,
        value,
        domain: hostKey,
        path: row.path || "/",
        expires: chromeExpiresToUnix(row.expires_utc ?? 0),
        secure: Boolean(row.secure_col),
        httpOnly: Boolean(row.httponly_col),
        sameSite: SAMESITE_MAP[row.samesite] ?? "Lax",
      });
    }
  } catch (e) {
    console.error(`[cookies] Reading Chrome's cookie store failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.error(
    `[cookies] Imported ${result.cookies.length} cookies for ${domains.join(", ")} ` +
      `(skipped ${result.skippedAppBound} app-bound, ${result.skippedWrongKey} undecryptable)`,
  );
  return result;
}
