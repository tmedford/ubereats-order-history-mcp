/**
 * Tool definitions and handlers. Every tool is READ-ONLY: nothing here can place, change,
 * tip, rate or pay for an order - the only Uber Eats operations this server ever calls are
 * the three read RPCs in ubereats/client.ts.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { addDays, historyWarning, type UberEatsClient } from "../ubereats/client";
import { normalizeName, withReceiptLineTotals } from "../ubereats/orders";
import { CsvKind, itemsCsv, ordersCsv, transactionsCsv } from "./csv";

export const TOOLS = [
  {
    name: "check_ubereats_auth_status",
    description:
      "Check whether the connector is signed in to Uber Eats. It reuses the session from your Google Chrome (cookies are copied from Chrome on every start and whenever a call finds the session expired) - it never asks for a password.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_ubereats_orders",
    description:
      "List Uber Eats orders newest-first, read from Uber Eats' own order-history feed: store, dates, status, every item with quantity/unit price/options, and the fare breakdown (subtotal, tax, delivery fee, service fee, tip, discounts, total). Stops paging as soon as it passes start_date. Set include_receipts to also attach each order's card charges.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Inclusive YYYY-MM-DD (order placed date, local time)." },
        end_date: { type: "string", description: "Inclusive YYYY-MM-DD." },
        max_pages: { type: "number", description: "Safety cap, 10 orders per page. Default 60." },
        store: {
          type: "string",
          description:
            'Only orders from stores whose name contains this, e.g. "home depot" or "mcdonalds" (case and symbols ignored).',
        },
        include_items: { type: "boolean", description: "Include line items (default true)." },
        include_receipts: {
          type: "boolean",
          description:
            "Also fetch each order's receipt: card, amount and time of every charge/refund (one extra call per order). Default false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_ubereats_order_details",
    description:
      "Everything about one Uber Eats order: items and options, fare breakdown, and (by default) its receipt - every card charge, separately-billed tip and refund with the card brand, last 4 digits, amount and time, plus pickup/drop-off addresses.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order id (UUID) from get_ubereats_orders." },
        include_receipt: { type: "boolean", description: "Default true." },
      },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_ubereats_transactions",
    description:
      "Every card charge and refund Uber Eats made, one row each - the shape of a card statement: charge time, amount, card brand + last 4, the order and store it paid for, and whether it is a tip billed after delivery. Use this to match bank/card transactions to orders. Charges are kept by their own date, so a tip or refund that posted days after the order is included.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Inclusive YYYY-MM-DD (charge date)." },
        end_date: { type: "string", description: "Inclusive YYYY-MM-DD." },
        card_last4: { type: "string", description: "Only charges on this card (last 4 digits)." },
        store: {
          type: "string",
          description:
            'Only orders from stores whose name contains this, e.g. "home depot" or "mcdonalds" (case and symbols ignored).',
        },

        lookback_days: {
          type: "number",
          description: "Also scan orders placed this many days before start_date (late tips/refunds). Default 7.",
        },
        max_pages: { type: "number", description: "Safety cap on order-history pages. Default 60." },
      },
      required: ["start_date"],
      additionalProperties: false,
    },
  },
  {
    name: "export_ubereats_csv",
    description:
      "Write orders, line items or card transactions to a CSV file (default ~/Downloads). Returns the path and row count.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["orders", "items", "transactions"] },
        start_date: { type: "string", description: "Inclusive YYYY-MM-DD." },
        end_date: { type: "string", description: "Inclusive YYYY-MM-DD." },
        output_path: { type: "string", description: "File to write. Default ~/Downloads/ubereats-<kind>-<dates>.csv" },
        store: {
          type: "string",
          description:
            'Only orders from stores whose name contains this, e.g. "home depot" or "mcdonalds" (case and symbols ignored).',
        },

        max_pages: { type: "number", description: "Default 60." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
] as const;

export class InputError extends Error {}

function optStore(args: Record<string, unknown>): string | undefined {
  const v = args.store;
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 80)
    throw new InputError("store must be a store name (at most 80 characters)");
  if (!normalizeName(v)) throw new InputError("store must contain letters or digits");
  return v;
}

/** Every warning that applies to a walk, joined - never just the first. */
function warnings(
  res: { truncated: boolean; reachedEnd: boolean; oldestSeen: string | null },
  startDate?: string,
  searchStart = startDate,
) {
  const w = [
    res.truncated ? "Stopped at max_pages before reaching start_date; raise max_pages for older orders." : null,
    historyWarning(res, startDate, searchStart),
  ].filter(Boolean);
  return w.length ? { warning: w.join(" ") } : {};
}

/**
 * Write `data` so it is never readable by anyone else, even for an instant: it goes to a
 * fresh 0600 temp file in the same directory (created exclusively), which is then renamed
 * over the destination. Overwriting an existing 0644 file therefore never exposes the new
 * data under the old permissions.
 */
export function writePrivateFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

type Args = Record<string, unknown>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function optDate(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new InputError(`${key} must be a date like 2026-09-25`);
  }
  return v;
}

function optInt(args: Args, key: string, dflt: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${key} must be an integer ${min}-${max}`);
  return n;
}

function optBool(args: Args, key: string, dflt: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw new InputError(`${key} must be true or false`);
  return v;
}

function checkRange(start?: string, end?: string): void {
  if (start && end && start > end) throw new InputError("start_date is after end_date");
}

export async function handleTool(
  name: string,
  args: Args,
  client: UberEatsClient,
  env: { chromeVersion?: string } = {},
): Promise<unknown> {
  switch (name) {
    case "check_ubereats_auth_status": {
      const st = await client.checkSignedIn();
      return {
        status: "success",
        authenticated: st.authenticated,
        message: st.authenticated ? "Signed in to Uber Eats (session from Chrome)." : st.message,
        chromeVersion: env.chromeVersion ?? null,
        timeZone: client.timeZone,
      };
    }

    case "get_ubereats_orders": {
      const startDate = optDate(args, "start_date");
      const endDate = optDate(args, "end_date");
      checkRange(startDate, endDate);
      const maxPages = optInt(args, "max_pages", 60, 1, 500);
      const store = optStore(args);
      const res = await client.listOrders({ startDate, endDate, maxPages, store });
      const includeItems = optBool(args, "include_items", true);
      let list = res.orders;
      const receipts = optBool(args, "include_receipts", false)
        ? await client.receiptsFor(list.map((o) => o.id))
        : null;
      if (receipts) {
        list = list.map((o, i) => {
          const r = receipts[i];
          return "error" in r ? o : withReceiptLineTotals(o, r.items);
        });
      }
      const orders: Record<string, unknown>[] = list.map((o, i) => ({
        ...o,
        ...(includeItems ? {} : { items: undefined }),
        ...(receipts ? { receipt: receipts[i] } : {}),
      }));
      return {
        status: "success",
        params: { startDate, endDate, maxPages, store: store ?? null, timeZone: client.timeZone },
        orderCount: orders.length,
        pages: res.pages,
        oldestOrderSeen: res.oldestSeen,
        ...warnings(res, startDate),
        orders,
      };
    }

    case "get_ubereats_order_details": {
      const id = args.order_id;
      if (typeof id !== "string" || !UUID.test(id)) throw new InputError("order_id must be an order UUID");
      let order = await client.getOrder(id);
      const receipt = optBool(args, "include_receipt", true) ? await client.getReceipt(id) : undefined;
      if (receipt) order = withReceiptLineTotals(order, receipt.items);
      return { status: "success", order, ...(receipt ? { receipt } : {}) };
    }

    case "get_ubereats_transactions": {
      const startDate = optDate(args, "start_date");
      if (!startDate) throw new InputError("start_date is required");
      const endDate = optDate(args, "end_date");
      checkRange(startDate, endDate);
      const last4 = args.card_last4;
      if (last4 !== undefined && (typeof last4 !== "string" || !/^\d{4}$/.test(last4))) {
        throw new InputError("card_last4 must be 4 digits");
      }
      const store = optStore(args);
      const lookbackDays = optInt(args, "lookback_days", 7, 0, 60);
      const res = await client.listTransactions({
        startDate,
        endDate,
        store,
        maxPages: optInt(args, "max_pages", 60, 1, 500),
        lookbackDays,
      });
      const txns = last4 ? res.transactions.filter((t) => t.last4 === last4) : res.transactions;
      return {
        status: "success",
        params: { startDate, endDate, cardLast4: last4 ?? null, store: store ?? null, timeZone: client.timeZone },
        transactionCount: txns.length,
        total: Math.round(txns.reduce((s, t) => s + (t.amount ?? 0), 0) * 100) / 100,
        ...(txns.some((t) => t.amount === null)
          ? { note: "Some receipts printed no amount for a charge (amount: null)." }
          : {}),
        ordersScanned: res.ordersScanned,
        ...warnings(res, startDate, addDays(startDate, -lookbackDays)),
        ...(res.receiptErrors.length ? { receiptErrors: res.receiptErrors } : {}),
        transactions: txns,
      };
    }

    case "export_ubereats_csv": {
      const kind = args.kind as CsvKind;
      if (!["orders", "items", "transactions"].includes(kind))
        throw new InputError("kind must be orders, items or transactions");
      const startDate = optDate(args, "start_date");
      const endDate = optDate(args, "end_date");
      checkRange(startDate, endDate);
      if (kind === "transactions" && !startDate) throw new InputError("start_date is required for transactions");
      const maxPages = optInt(args, "max_pages", 60, 1, 500);
      const store = optStore(args);
      let csv: string;
      let rows: number;
      let warn: { warning?: string };
      if (kind === "transactions") {
        const res = await client.listTransactions({ startDate, endDate, maxPages, store });
        csv = transactionsCsv(res.transactions);
        rows = res.transactions.length;
        warn = warnings(res, startDate, startDate ? addDays(startDate, -7) : undefined);
      } else {
        const res = await client.listOrders({ startDate, endDate, maxPages, store });
        csv = kind === "orders" ? ordersCsv(res.orders) : itemsCsv(res.orders);
        rows = kind === "orders" ? res.orders.length : res.orders.reduce((s, o) => s + o.items.length, 0);
        warn = warnings(res, startDate);
      }
      const out =
        typeof args.output_path === "string" && args.output_path
          ? resolve(args.output_path.replace(/^~(?=$|\/)/, homedir()))
          : join(homedir(), "Downloads", `ubereats-${kind}-${startDate ?? "all"}-to-${endDate ?? "now"}.csv`);
      writePrivateFile(out, csv);
      return { status: "success", kind, path: out, rows, ...warn };
    }

    default:
      throw new InputError(`unknown tool ${name}`);
  }
}
