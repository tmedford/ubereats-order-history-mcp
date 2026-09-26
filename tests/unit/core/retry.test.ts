import { mapLimit, withRetry } from "../../../src/core/retry";

describe("withRetry", () => {
  test("retries only retryable errors, with the given backoff", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const v = await withRetry(
      async () => {
        if (++n < 3) throw new Error("flaky");
        return "ok";
      },
      { backoffMs: [5, 10, 20], isRetryable: () => true, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(v).toBe("ok");
    expect(sleeps).toEqual([5, 10]);
  });

  test("a non-retryable error is thrown immediately", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error("fatal");
        },
        { backoffMs: [1, 1], isRetryable: () => false, sleep: async () => undefined },
      ),
    ).rejects.toThrow("fatal");
    expect(n).toBe(1);
  });

  test("onRetry runs before each retry", async () => {
    const seen: number[] = [];
    await expect(
      withRetry(async () => Promise.reject(new Error("x")), {
        backoffMs: [1, 1],
        isRetryable: () => true,
        sleep: async () => undefined,
        onRetry: (_e, attempt) => void seen.push(attempt),
      }),
    ).rejects.toThrow("x");
    expect(seen).toEqual([1, 2]);
  });
});

describe("mapLimit", () => {
  test("preserves order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([30, 10, 20, 5, 15], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  test("empty input", async () => expect(await mapLimit([], 4, async () => 1)).toEqual([]));
});
