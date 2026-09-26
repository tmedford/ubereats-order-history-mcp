import { AuthGuard, AuthGuardDeps, SignInCheck } from "../../../src/core/auth-guard";

function deps(checks: (SignInCheck | Error)[], clock = { t: 0 }) {
  const calls = { check: 0, reimport: 0, sleeps: [] as number[] };
  const d: AuthGuardDeps = {
    check: async () => {
      const c = checks[Math.min(calls.check++, checks.length - 1)];
      if (c instanceof Error) throw c;
      return c;
    },
    reimport: async () => {
      calls.reimport++;
      return 5;
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
  };
  return { d, calls, clock };
}

const IN: SignInCheck = { authenticated: true };
const OUT: SignInCheck = { authenticated: false, message: "missing user uuid" };
const opts = { ttlMs: 1000, backoffMs: [1, 3, 10] };

describe("AuthGuard", () => {
  test("signed in: no re-import", async () => {
    const { d, calls } = deps([IN]);
    await expect(new AuthGuard(d, opts).ensure()).resolves.toEqual({ ok: true, repaired: false, attempts: 0 });
    expect(calls.reimport).toBe(0);
  });

  test("an expired session is repaired by re-importing Chrome's cookies", async () => {
    const { d, calls } = deps([OUT, OUT, IN]);
    await expect(new AuthGuard(d, opts).ensure()).resolves.toEqual({ ok: true, repaired: true, attempts: 2 });
    expect(calls.sleeps).toEqual([1, 3]);
  });

  test("gives up with a typed NOT_SIGNED_IN - never an empty success", async () => {
    const { d, calls } = deps([OUT]);
    const r = await new AuthGuard(d, opts).ensure();
    expect(r).toMatchObject({ ok: false, code: "NOT_SIGNED_IN", attempts: 3 });
    if (!r.ok) expect(r.message).toMatch(/Chrome/);
    expect(calls.reimport).toBe(3);
  });

  test("a check that throws counts as signed out and is retried", async () => {
    const { d } = deps([new Error("page crashed"), IN]);
    await expect(new AuthGuard(d, opts).ensure()).resolves.toMatchObject({ ok: true, repaired: true });
  });

  test("success is trusted for ttlMs; invalidate() forces a re-check", async () => {
    const { d, calls, clock } = deps([IN]);
    const g = new AuthGuard(d, opts);
    await g.ensure();
    await g.ensure();
    expect(calls.check).toBe(1);
    clock.t += 1001;
    await g.ensure();
    expect(calls.check).toBe(2);
    g.invalidate();
    await g.ensure();
    expect(calls.check).toBe(3);
  });

  test("concurrent callers share one check", async () => {
    const { d, calls } = deps([OUT, IN]);
    const g = new AuthGuard(d, opts);
    const [a, b] = await Promise.all([g.ensure(), g.ensure()]);
    expect(a).toEqual(b);
    expect(calls.check).toBe(2);
    expect(calls.reimport).toBe(1);
  });

  test("a failing re-import does not crash - it counts as nothing imported", async () => {
    const { d } = deps([OUT, IN]);
    d.reimport = async () => {
      throw new Error("keychain denied");
    };
    await expect(new AuthGuard(d, opts).ensure()).resolves.toMatchObject({ ok: true });
  });

  test("stops early when Chrome has no session to import", async () => {
    const { d, calls } = deps([OUT]);
    d.reimport = async () => 0;
    const r = await new AuthGuard(d, opts).ensure();
    expect(r).toMatchObject({ ok: false, code: "NOT_SIGNED_IN", attempts: 1 });
    expect(calls.sleeps).toEqual([1]);
  });
});
