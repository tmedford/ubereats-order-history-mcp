import { readFileSync } from "fs";
import { join } from "path";
import { addDays, localDate, OPS, toTransactions, UberEatsClient } from "../../../src/ubereats/client";
import { parseOrdersPage } from "../../../src/ubereats/orders";
import { parseReceiptHtml } from "../../../src/ubereats/receipt";
import { UberEatsError, UberEatsRpc } from "../../../src/ubereats/rpc";

const fixtures = join(__dirname, "../../fixtures");
const page = JSON.parse(readFileSync(join(fixtures, "past-orders-page.json"), "utf8"));
const receiptHtml = (n: string) => readFileSync(join(fixtures, `receipt-${n}.html`), "utf8");

/** A fake RPC whose history is `pages` (arrays of raw orders) chained by last id. */
function fakeRpc(pages: unknown[][], receipts: Record<string, string> = {}, calls: { op: string; body: any }[] = []) {
  const ids = pages.map((p) => p.map((o: any) => o.baseEaterOrder.uuid));
  return {
    calls,
    rpc: {
      call: async (op: string, body: any) => {
        calls.push({ op, body });
        if (op === OPS.pastOrders) {
          const i = body.lastWorkflowUUID ? ids.findIndex((p) => p[p.length - 1] === body.lastWorkflowUUID) + 1 : 0;
          const p = pages[i] ?? [];
          return {
            orderUuids: ids[i] ?? [],
            ordersMap: Object.fromEntries(p.map((o: any) => [o.baseEaterOrder.uuid, o])),
            meta: { hasMore: i < pages.length - 1 },
          };
        }
        if (op === OPS.receipt) {
          if (!receipts[body.workflowUuid]) throw new UberEatsError("API_ERROR", "invalid workflowUUID", false);
          return { receiptData: receipts[body.workflowUuid] };
        }
        if (op === OPS.pastOrder) return { order: page.ordersMap[body.workflowUuid] };
        throw new Error(`unexpected ${op}`);
      },
    } as unknown as UberEatsRpc,
  };
}

/** Clone a raw order with a new id and CREATED time. */
function order(id: string, created: string) {
  const o = structuredClone(page.ordersMap[page.orderUuids[0]]);
  o.baseEaterOrder.uuid = id;
  o.baseEaterOrder.orderStateChanges = [{ type: "CREATED", stateChangeTime: created }];
  o.baseEaterOrder.completedAt = created;
  return o;
}

describe("dates", () => {
  test("localDate uses the client's zone, not UTC", () => {
    expect(localDate("2026-09-22T00:04:38.000Z", "America/New_York")).toBe("2026-09-21");
    expect(localDate("2026-09-22T00:04:38.000Z", "UTC")).toBe("2026-09-22");
    expect(localDate(null, "UTC")).toBeNull();
  });
  test("addDays crosses months", () => expect(addDays("2026-03-01", -1)).toBe("2026-02-28"));
});

describe("listOrders paging", () => {
  const history = [
    [order("a", "2026-09-20T15:00:00Z"), order("b", "2026-09-10T15:00:00Z")],
    [order("c", "2026-08-30T15:00:00Z"), order("d", "2026-08-20T15:00:00Z")],
    [order("e", "2026-08-01T15:00:00Z"), order("f", "2026-07-01T15:00:00Z")],
  ];

  test("pages by the previous page's LAST order id and walks to the end", async () => {
    const f = fakeRpc(history);
    const res = await new UberEatsClient(f.rpc, "UTC").listOrders();
    expect(res.orders.map((o) => o.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(f.calls.map((c) => c.body.lastWorkflowUUID)).toEqual(["", "b", "d"]);
    expect(res).toMatchObject({ pages: 3, truncated: false, oldestSeen: "2026-07-01" });
  });

  test("stops as soon as a page reaches past start_date; end_date is inclusive", async () => {
    const f = fakeRpc(history);
    const res = await new UberEatsClient(f.rpc, "UTC").listOrders({ startDate: "2026-08-25", endDate: "2026-09-10" });
    expect(res.orders.map((o) => o.id)).toEqual(["b", "c"]);
    expect(res.pages).toBe(2); // never fetched page 3
    expect(res.truncated).toBe(false);
  });

  test("max_pages cap is reported as truncated", async () => {
    const res = await new UberEatsClient(fakeRpc(history).rpc, "UTC").listOrders({ maxPages: 1 });
    expect(res).toMatchObject({ pages: 1, truncated: true });
  });

  test("a page that repeats (stuck cursor) ends the walk instead of looping", async () => {
    const stuck = {
      call: async () => ({
        orderUuids: ["a"],
        ordersMap: { a: order("a", "2026-09-20T15:00:00Z") },
        meta: { hasMore: true },
      }),
    } as unknown as UberEatsRpc;
    const res = await new UberEatsClient(stuck, "UTC").listOrders({ maxPages: 50 });
    expect(res.orders).toHaveLength(1);
    expect(res.pages).toBe(2);
  });
});

describe("checkSignedIn", () => {
  test("typed signed-out error -> authenticated false; other errors propagate", async () => {
    const signedOut = {
      call: async () => Promise.reject(new UberEatsError("NOT_SIGNED_IN", "missing user uuid", false)),
    };
    await expect(new UberEatsClient(signedOut as any, "UTC").checkSignedIn()).resolves.toMatchObject({
      authenticated: false,
    });
    const broken = { call: async () => Promise.reject(new UberEatsError("UPSTREAM_ERROR", "502", true)) };
    await expect(new UberEatsClient(broken as any, "UTC").checkSignedIn()).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    await expect(new UberEatsClient(fakeRpc([[]]).rpc, "UTC").checkSignedIn()).resolves.toEqual({
      authenticated: true,
    });
  });
});

describe("transactions", () => {
  const orders = parseOrdersPage(page).orders;
  const homeDepot = orders.find((o) => o.store.name === "The Home Depot")!;

  test("one row per charge, tip on another card recognised, refund negative", () => {
    const txns = toTransactions(homeDepot, parseReceiptHtml(receiptHtml("split-charges"), homeDepot.id));
    expect(txns.map((t) => [t.last4, t.amount, t.kind, t.isTip, t.store])).toEqual([
      ["2222", 22.3, "charge", false, "The Home Depot"],
      ["1111", 2.56, "charge", true, "The Home Depot"],
      ["2222", -6.13, "refund", false, "The Home Depot"],
    ]);
  });

  test("listTransactions keeps charges by their own date and reports receipt failures", async () => {
    const hd = page.ordersMap[homeDepot.id];
    const target = page.ordersMap[orders[0].id];
    const f = fakeRpc([[target, hd]], { [homeDepot.id]: receiptHtml("split-charges") });
    const res = await new UberEatsClient(f.rpc, "UTC").listTransactions({
      startDate: "2026-06-24",
      endDate: "2026-06-24",
    });
    expect(res.transactions.map((t) => t.amount)).toEqual([-6.13, 2.56, 22.3]); // newest charge first
    expect(res.receiptErrors).toEqual([]); // Target is outside the window, so its receipt is never requested
    expect(f.calls.filter((c) => c.op === OPS.receipt)).toHaveLength(1);

    const g = fakeRpc([[target, hd]], {});
    const res2 = await new UberEatsClient(g.rpc, "UTC").listTransactions({ startDate: "2026-06-01" });
    expect(res2.transactions).toEqual([]);
    expect(res2.receiptErrors.map((e) => e.orderId).sort()).toEqual([homeDepot.id, orders[0].id].sort());
  });

  test("an undated charge is dropped from a bounded query (it cannot be shown in range)", async () => {
    const raw = order("u", "2026-09-20T15:00:00Z");
    delete raw.baseEaterOrder.orderStateChanges;
    delete raw.baseEaterOrder.completedAt;
    delete raw.baseEaterOrder.lastStateChangeAt;
    const html = receiptHtml("grocery").replace(/data-testid="payments_0_date_time"/, 'data-testid="x"');
    const f = fakeRpc([[raw]], { u: html });
    const bounded = await new UberEatsClient(f.rpc, "UTC").listTransactions({
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    expect(bounded.transactions).toEqual([]);
    const open = await new UberEatsClient(fakeRpc([[raw]], { u: html }).rpc, "UTC").listTransactions();
    expect(open.transactions).toHaveLength(1);
  });

  test("a signed-out receipt aborts the whole listing (so the guard can repair it)", async () => {
    const rpc = {
      call: async (op: string) =>
        op === OPS.pastOrders
          ? { orderUuids: ["a"], ordersMap: { a: order("a", "2026-09-20T15:00:00Z") }, meta: { hasMore: false } }
          : Promise.reject(new UberEatsError("NOT_SIGNED_IN", "missing user uuid", false)),
    } as unknown as UberEatsRpc;
    await expect(new UberEatsClient(rpc, "UTC").listTransactions({ startDate: "2026-09-01" })).rejects.toMatchObject({
      code: "NOT_SIGNED_IN",
    });
  });

  test("getOrder / getReceipt surface missing data as API errors", async () => {
    const empty = { call: async () => ({}) } as unknown as UberEatsRpc;
    const c = new UberEatsClient(empty, "UTC");
    await expect(c.getOrder("x")).rejects.toMatchObject({ code: "API_ERROR" });
    await expect(c.getReceipt("x")).rejects.toMatchObject({ code: "API_ERROR" });
  });
});
