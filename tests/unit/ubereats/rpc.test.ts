import {
  ALLOWED_OPERATIONS,
  isAllowedRequestUrl,
  parseRpcResponse,
  RpcResponse,
  RpcTransport,
  sanitizeSnippet,
  UberEatsError,
  UberEatsRpc,
} from "../../../src/ubereats/rpc";

const OP = "getPastOrdersV1";

const ok = (data: unknown): RpcResponse => ({ status: 200, text: JSON.stringify({ status: "success", data }) });
const fail = (message: string, code: unknown = 3): RpcResponse => ({
  status: 200,
  text: JSON.stringify({ status: "failure", data: { message, code } }),
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as UberEatsError).code;
  }
  return "NO_THROW";
};

describe("parseRpcResponse", () => {
  test("success returns data", () => expect(parseRpcResponse("op", ok({ a: 1 }))).toEqual({ a: 1 }));

  test("the real signed-out reply is NOT_SIGNED_IN", () => {
    const signedOut = fail(
      "InvalidRequestError{Info: ErrorInfo{Message: Invalid Request, Code: invalid.request.error, StatusCode: 400, ShouldRetry: false, Stack: *errors.errorString missing user uuid when fetching orders, SubCode: }}",
    );
    expect(code(() => parseRpcResponse("getPastOrdersV1", signedOut))).toBe("NOT_SIGNED_IN");
  });

  test.each([
    [{ status: 401, text: "" }, "NOT_SIGNED_IN"],
    [{ status: 429, text: "slow down" }, "RATE_LIMITED"],
    [{ status: 403, text: "Missing csrf token." }, "CSRF_REJECTED"],
    [{ status: 403, text: "<!DOCTYPE html><title>Just a moment...</title>" }, "BOT_CHALLENGE"],
    [{ status: 503, text: "{}" }, "UPSTREAM_ERROR"],
    [{ status: 200, text: "not json" }, "UPSTREAM_ERROR"],
    [fail("invalid workflowUUID", "400"), "API_ERROR"],
  ])("%j -> %s", (res, expected) => expect(code(() => parseRpcResponse("op", res as RpcResponse))).toBe(expected));
});

function scripted(replies: (RpcResponse | Error)[]) {
  const calls: string[] = [];
  let resets = 0;
  const t: RpcTransport = {
    post: async (op) => {
      calls.push(op);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    reset: async () => {
      resets++;
    },
  };
  return { t, calls, resets: () => resets };
}

describe("UberEatsRpc", () => {
  const sleeps: number[] = [];
  const opts = { backoffMs: [1, 2, 3], sleep: async (ms: number) => void sleeps.push(ms) };

  test("retries a bot challenge on a fresh page, then succeeds", async () => {
    const s = scripted([{ status: 403, text: "<html>challenge</html>" }, ok({ v: 1 })]);
    await expect(new UberEatsRpc(s.t, opts).call(OP, {})).resolves.toEqual({ v: 1 });
    expect(s.calls).toHaveLength(2);
    expect(s.resets()).toBe(1);
  });

  test("retries rate limits and transport failures with backoff", async () => {
    const s = scripted([{ status: 429, text: "" }, new Error("Target page closed"), ok("done")]);
    await expect(new UberEatsRpc(s.t, opts).call(OP, {})).resolves.toBe("done");
    expect(s.calls).toHaveLength(3);
  });

  test("does not retry a signed-out reply (the auth guard owns that)", async () => {
    const s = scripted([fail("missing user uuid")]);
    await expect(new UberEatsRpc(s.t, opts).call(OP, {})).rejects.toMatchObject({ code: "NOT_SIGNED_IN" });
    expect(s.calls).toHaveLength(1);
  });

  test("gives up after the backoff list with the last error", async () => {
    const s = scripted([{ status: 502, text: "" }]);
    await expect(new UberEatsRpc(s.t, opts).call(OP, {})).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(s.calls).toHaveLength(4);
  });
});

describe("authorization boundaries", () => {
  test("only the three read operations are allowed, and nothing is sent for anything else", async () => {
    expect([...ALLOWED_OPERATIONS].sort()).toEqual(["getPastOrderV1", "getPastOrdersV1", "getReceiptByWorkflowUuidV1"]);
    const s = scripted([ok({})]);
    const rpc = new UberEatsRpc(s.t, { backoffMs: [], sleep: async () => undefined });
    for (const op of ["createDraftOrderV2", "checkoutOrdersByDraftOrdersV1", "addTipV1", "getPastOrdersV1/../x", ""]) {
      await expect(rpc.call(op, {})).rejects.toThrow(/read-only allowlist/);
    }
    expect(s.calls).toHaveLength(0);
  });

  test.each([
    ["https://www.ubereats.com/robots.txt", true],
    ["https://www.ubereats.com/_p/api/getPastOrdersV1", true],
    ["https://ubereats.com/", true],
    ["http://www.ubereats.com/", false], // never plaintext
    ["https://www.ubereats.com.evil.io/", false],
    ["https://evilubereats.com/", false],
    ["https://analytics.google.com/g/collect", false],
    ["https://auth.uber.com/login", false],
    ["about:blank", false],
    ["data:text/html,<script>1</script>", false],
    ["not a url", false],
  ])("automation page may load %s: %s", (url, allowed) => expect(isAllowedRequestUrl(url)).toBe(allowed));

  test("error snippets strip token-shaped strings and are bounded", () => {
    // assembled at runtime so the repo leak gate (scripts/check-leaks.mjs) never sees a JWT literal
    const jwt = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiIxMjM0In0", "c2lnbmF0dXJlLXZhbHVlLWhlcmU"].join(".");
    const out = sanitizeSnippet(`bad ${jwt} sid=${"a".repeat(64)} hash ${"f".repeat(40)} ${"x ".repeat(200)}`);
    expect(out).not.toContain("eyJ");
    expect(out).not.toMatch(/a{40}|f{32}/);
    expect(out.length).toBeLessThanOrEqual(160);
  });

  test("an upstream error code is shown only when short and plain", () => {
    const msg = (c: unknown) => {
      try {
        parseRpcResponse(OP, fail("nope", c));
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    expect(msg("400")).toMatch(/\(code 400\)$/);
    expect(msg(3)).toMatch(/\(code 3\)$/);
    const token = "t0k" + "e".repeat(60);
    expect(msg(token)).not.toContain(token);
    expect(msg({ secret: "x" })).not.toMatch(/code/);
  });

  test("API failure messages reaching the client are sanitized", () => {
    try {
      parseRpcResponse(OP, fail(`boom eyJa.eyJb.sig ${"z".repeat(50)}`));
    } catch (e) {
      expect((e as Error).message).not.toMatch(/eyJ|z{40}/);
    }
  });
});
