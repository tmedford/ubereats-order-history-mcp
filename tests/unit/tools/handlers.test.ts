import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { csvCell, itemsCsv, ordersCsv, transactionsCsv } from "../../../src/tools/csv";
import { handleTool, InputError, optDate, TOOLS, writePrivateFile } from "../../../src/tools/handlers";
import type { UberEatsClient } from "../../../src/ubereats/client";
import { toTransactions } from "../../../src/ubereats/client";
import { parseOrdersPage } from "../../../src/ubereats/orders";
import { parseReceiptHtml } from "../../../src/ubereats/receipt";

const fx = join(__dirname, "../../fixtures");
const orders = parseOrdersPage(JSON.parse(readFileSync(join(fx, "past-orders-page.json"), "utf8"))).orders;
const split = parseReceiptHtml(readFileSync(join(fx, "receipt-split-charges.html"), "utf8"), orders[3].id);
const txns = toTransactions(orders[3], split);

const client = {
  timeZone: "UTC",
  checkSignedIn: async () => ({ authenticated: true }),
  listOrders: jest.fn(async () => ({ orders, pages: 1, truncated: false, oldestSeen: "2026-04-16", reachedEnd: true })),
  receiptsFor: jest.fn(async (ids: string[]) =>
    ids.map((id) => (id === orders[3].id ? split : { orderId: id, error: "boom" })),
  ),
  getOrder: async () => orders[2],
  getReceipt: async () => split,
  listTransactions: jest.fn(async () => ({
    transactions: txns,
    ordersScanned: 1,
    pages: 1,
    truncated: false,
    receiptErrors: [],
  })),
} as unknown as UberEatsClient;

describe("tool list", () => {
  test("every tool is read-only by name and documented", () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^(check|get|export)_ubereats_/);
      expect(t.description.length).toBeGreaterThan(40);
    }
  });
});

describe("input validation", () => {
  test.each([["2026-13-45"], ["09/25/2026"], [20260925]])("rejects date %j", (v) => {
    expect(() => optDate({ start_date: v }, "start_date")).toThrow(InputError);
  });
  test("start after end is rejected", async () => {
    await expect(
      handleTool("get_ubereats_orders", { start_date: "2026-09-02", end_date: "2026-09-01" }, client),
    ).rejects.toThrow(/after end_date/);
  });
  test("order_id must be a UUID; card_last4 must be 4 digits; transactions need a start", async () => {
    await expect(handleTool("get_ubereats_order_details", { order_id: "1; drop" }, client)).rejects.toThrow(InputError);
    await expect(
      handleTool("get_ubereats_transactions", { start_date: "2026-06-01", card_last4: "12" }, client),
    ).rejects.toThrow(InputError);
    await expect(handleTool("get_ubereats_transactions", {}, client)).rejects.toThrow(/required/);
    await expect(handleTool("nope", {}, client)).rejects.toThrow(InputError);
  });
});

describe("store filter and history warning through the tools", () => {
  test("store is passed through to orders, transactions and export", async () => {
    await handleTool("get_ubereats_orders", { store: "home depot" }, client);
    expect((client.listOrders as jest.Mock).mock.calls.at(-1)[0]).toMatchObject({ store: "home depot" });
    await handleTool("get_ubereats_transactions", { start_date: "2026-06-24", store: "target" }, client);
    expect((client.listTransactions as jest.Mock).mock.calls.at(-1)[0]).toMatchObject({ store: "target" });
  });
  test("an invalid store is rejected", async () => {
    await expect(handleTool("get_ubereats_orders", { store: 5 }, client)).rejects.toThrow(InputError);
    await expect(handleTool("get_ubereats_orders", { store: "x".repeat(81) }, client)).rejects.toThrow(InputError);
  });
  test("start_date before the served history returns a warning naming where it starts", async () => {
    const r: any = await handleTool("get_ubereats_orders", { start_date: "2023-01-01" }, client);
    expect(r.warning).toMatch(/back to 2026-04-16 only/);
    const inside: any = await handleTool("get_ubereats_orders", { start_date: "2026-05-01" }, client);
    expect(inside.warning).toBeUndefined();
  });
});

describe("handlers", () => {
  test("orders: include_receipts attaches receipts and applies printed line totals", async () => {
    const r: any = await handleTool("get_ubereats_orders", { include_receipts: true }, client);
    expect(r).toMatchObject({ status: "success", orderCount: 4, pages: 1, oldestOrderSeen: "2026-04-16" });
    expect(r.orders[3].receipt.payments).toHaveLength(3);
    expect(r.orders[0].receipt).toMatchObject({ error: "boom" });
  });

  test("orders: include_items=false drops line items", async () => {
    const r: any = await handleTool("get_ubereats_orders", { include_items: false }, client);
    expect(r.orders[0].items).toBeUndefined();
  });

  test("transactions: filter by card, total the rows", async () => {
    const all: any = await handleTool("get_ubereats_transactions", { start_date: "2026-06-24" }, client);
    expect(all).toMatchObject({ transactionCount: 3, total: 18.73 });
    const amex: any = await handleTool(
      "get_ubereats_transactions",
      { start_date: "2026-06-24", card_last4: "1111" },
      client,
    );
    expect(amex.transactions.map((t: any) => [t.amount, t.isTip])).toEqual([[2.56, true]]);
  });

  test("details: receipt line totals override the computed ones", async () => {
    const r: any = await handleTool("get_ubereats_order_details", { order_id: orders[2].id }, client);
    expect(r.order.id).toBe(orders[2].id);
    expect(r.receipt.payments).toHaveLength(3);
  });

  test("export writes a private CSV file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ue-csv-"));
    try {
      const out = join(dir, "sub", "t.csv");
      const r: any = await handleTool(
        "export_ubereats_csv",
        { kind: "transactions", start_date: "2026-06-24", output_path: out },
        client,
      );
      expect(r).toMatchObject({ status: "success", rows: 3, path: out });
      expect(readFileSync(out, "utf8").split("\n")[0]).toMatch(/^charged_at,amount,amount_inferred,kind,is_tip/);
      expect(statSync(out).mode & 0o777).toBe(0o600);
      const items: any = await handleTool(
        "export_ubereats_csv",
        { kind: "items", output_path: join(dir, "i.csv") },
        client,
      );
      expect(items.rows).toBe(orders.reduce((s, o) => s + o.items.length, 0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writePrivateFile", () => {
  test("replacing an existing world-readable file never exposes data under the old mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "ue-private-"));
    try {
      const out = join(dir, "export.csv");
      writeFileSync(out, "old");
      chmodSync(out, 0o644);
      const oldInode = statSync(out).ino;
      writePrivateFile(out, "new,data\n");
      expect(readFileSync(out, "utf8")).toBe("new,data\n");
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(statSync(out).ino).not.toBe(oldInode); // a new 0600 file was renamed in; the 0644 one never held the data
      expect(readdirSync(dir)).toEqual(["export.csv"]); // no temp file left behind
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("csv", () => {
  test("quotes, escapes and neutralises formula injection", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-6.13")).toBe("-6.13");
    expect(csvCell(-6.13)).toBe("-6.13");
    expect(csvCell(null)).toBe("");
  });

  test("orders, items and transactions have one row per record plus a header", () => {
    expect(ordersCsv(orders).trim().split("\n")).toHaveLength(5);
    expect(itemsCsv(orders).trim().split("\n")).toHaveLength(1 + orders.reduce((s, o) => s + o.items.length, 0));
    expect(transactionsCsv(txns)).toContain("2026-06-24T11:50,2.56,false,charge,true,American Express,1111");
    expect(itemsCsv(orders)).toContain("Choose your drink: Milk");
  });
});
