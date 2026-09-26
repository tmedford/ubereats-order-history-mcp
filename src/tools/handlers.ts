/**
 * Tool definitions and handlers. Every tool is READ-ONLY: nothing here can place, change,
 * tip, rate or pay for an order - the only Uber Eats operations this server ever calls are
 * the three read RPCs in ubereats/client.ts.
 */

import { chmodSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { UberEatsClient } from "../ubereats/client";
import { withReceiptLineTotals } from "../ubereats/orders";
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
        max_pages: { type: "number", description: "Default 60." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
] as const;

export class InputError extends Error {}

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
      const res = await client.listOrders({ startDate, endDate, maxPages });
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
        params: { startDate, endDate, maxPages, timeZone: client.timeZone },
        orderCount: orders.length,
        pages: res.pages,
        oldestOrderSeen: res.oldestSeen,
        ...(res.truncated
          ? { warning: "Stopped at max_pages before reaching start_date; raise max_pages for older orders." }
          : {}),
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
      const res = await client.listTransactions({
        startDate,
        endDate,
        maxPages: optInt(args, "max_pages", 60, 1, 500),
        lookbackDays: optInt(args, "lookback_days", 7, 0, 60),
      });
      const txns = last4 ? res.transactions.filter((t) => t.last4 === last4) : res.transactions;
      return {
        status: "success",
        params: { startDate, endDate, cardLast4: last4 ?? null, timeZone: client.timeZone },
        transactionCount: txns.length,
        total: Math.round(txns.reduce((s, t) => s + (t.amount ?? 0), 0) * 100) / 100,
        ...(txns.some((t) => t.amount === null)
          ? { note: "Some receipts printed no amount for a charge (amount: null)." }
          : {}),
        ordersScanned: res.ordersScanned,
        ...(res.truncated ? { warning: "Stopped at max_pages before reaching start_date; raise max_pages." } : {}),
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
      let csv: string;
      let rows: number;
      if (kind === "transactions") {
        const res = await client.listTransactions({ startDate, endDate, maxPages });
        csv = transactionsCsv(res.transactions);
        rows = res.transactions.length;
      } else {
        const res = await client.listOrders({ startDate, endDate, maxPages });
        csv = kind === "orders" ? ordersCsv(res.orders) : itemsCsv(res.orders);
        rows = kind === "orders" ? res.orders.length : res.orders.reduce((s, o) => s + o.items.length, 0);
      }
      const out =
        typeof args.output_path === "string" && args.output_path
          ? resolve(args.output_path.replace(/^~(?=$|\/)/, homedir()))
          : join(homedir(), "Downloads", `ubereats-${kind}-${startDate ?? "all"}-to-${endDate ?? "now"}.csv`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, csv, { mode: 0o600 });
      chmodSync(out, 0o600); // mode only applies on create; an overwritten file keeps its old one
      return { status: "success", kind, path: out, rows };
    }

    default:
      throw new InputError(`unknown tool ${name}`);
  }
}
