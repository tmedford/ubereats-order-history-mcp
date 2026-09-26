import * as crypto from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  chromeExpiresToUnix,
  decryptCookieValue,
  deriveCbcKey,
  hostKeyPrefixMatches,
  hostMatchesDomain,
  importChromeCookies,
  V20EncryptedError,
} from "../../../src/core/chrome-cookies";

const key = deriveCbcKey(Buffer.from("test-safe-storage-password"));

/** Encrypt like Chrome does (v10, AES-128-CBC, IV of spaces, optional sha256(host) prefix). */
function chromeEncrypt(value: string, hostKey?: string): Buffer {
  const plain = hostKey
    ? Buffer.concat([crypto.createHash("sha256").update(hostKey).digest(), Buffer.from(value)])
    : Buffer.from(value);
  const c = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from("v10"), c.update(plain), c.final()]);
}

describe("cookie decryption", () => {
  test("store version >= 24 strips the sha256(host_key) prefix", () => {
    const blob = chromeEncrypt("session-value", ".ubereats.com");
    expect(hostKeyPrefixMatches(blob, key, ".ubereats.com")).toBe(true);
    expect(decryptCookieValue(blob, null, key, 24)).toBe("session-value");
  });

  test("older stores have no prefix", () => {
    expect(decryptCookieValue(chromeEncrypt("v"), null, key, 23)).toBe("v");
  });

  test("a wrong key or wrong host fails the prefix check (the row is skipped)", () => {
    const blob = chromeEncrypt("x", ".ubereats.com");
    expect(hostKeyPrefixMatches(blob, deriveCbcKey(Buffer.from("other")), ".ubereats.com")).toBe(false);
    expect(hostKeyPrefixMatches(blob, key, ".example.com")).toBe(false);
  });

  test("plaintext values pass through; empty blobs are empty", () => {
    expect(decryptCookieValue(null, "plain", key, 24)).toBe("plain");
    expect(decryptCookieValue(Buffer.alloc(0), null, key, 24)).toBe("");
  });

  test("app-bound (v20) and unknown formats are refused, never attempted", () => {
    expect(() => decryptCookieValue(Buffer.from("v20xxxxxxxx"), null, key, 24)).toThrow(V20EncryptedError);
    expect(() => decryptCookieValue(Buffer.from("zzzxxxxxxxx"), null, key, 24)).toThrow(V20EncryptedError);
  });
});

describe("helpers", () => {
  test.each([
    [".ubereats.com", "ubereats.com", true],
    ["www.ubereats.com", "ubereats.com", true],
    ["ubereats.com", "ubereats.com", true],
    ["auth.uber.com", "uber.com", true],
    [".ubereats.com", "uber.com", false],
    ["notubereats.com", "ubereats.com", false],
    ["ubereats.com.evil.io", "ubereats.com", false],
  ])("hostMatchesDomain(%j, %j) = %j", (host, domain, expected) =>
    expect(hostMatchesDomain(host, domain)).toBe(expected),
  );

  test("Chrome's 1601-epoch microseconds become unix seconds; 0 is a session cookie", () => {
    expect(chromeExpiresToUnix(13_400_000_000_000_000)).toBe(13_400_000_000 - 11_644_473_600);
    expect(chromeExpiresToUnix(0)).toBe(-1);
  });

  test("a profile without a cookie store imports nothing and does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-chrome-"));
    try {
      expect(importChromeCookies(["ubereats.com"], dir)).toEqual({
        cookies: [],
        skippedAppBound: 0,
        skippedWrongKey: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
