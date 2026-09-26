/**
 * High-level reads over the Uber Eats RPCs: order history (bounded by date, stopping as
 * soon as it passes the start), one order, its receipt, and the per-charge "transactions"
 * view that lines up with a card statement.
 */

import type { SignInCheck } from "../core/auth-guard";
import { mapLimit } from "../core/retry";
import { EatsOrder, normalizeName, parseOrder, parseOrdersPage, round2 } from "./orders";
import { EatsReceipt, parseReceiptHtml } from "./receipt";
import { UberEatsError, UberEatsRpc } from "./rpc";

export const OPS = {
  pastOrders: "getPastOrdersV1",
  pastOrder: "getPastOrderV1",
  receipt: "getReceiptByWorkflowUuidV1",
} as const;

/** YYYY-MM-DD in `timeZone` for an ISO instant. */
export function localDate(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ListOrdersOptions {
  /** Inclusive YYYY-MM-DD, in the client's time zone. */
  startDate?: string;
  endDate?: string;
  /** Safety cap on pages (10 orders each). */
  maxPages?: number;
  /** Only orders whose store name contains this (case- and symbol-insensitive). */
  store?: string;
  onPage?(page: number, ordersSoFar: number): void;
}

/**
 * Case-, mark- and punctuation-insensitive "name contains". A query with nothing searchable
 * left after normalising (e.g. only punctuation) matches NOTHING - never every order.
 * The tool layer rejects such a query up front; this is the backstop.
 */
export function storeMatches(order: EatsOrder, query: string | undefined): boolean {
  if (query === undefined || query === "") return true;
  const q = normalizeName(query);
  return q !== "" && normalizeName(order.store.name).includes(q);
}

export interface ListOrdersResult {
  orders: EatsOrder[];
  pages: number;
  /** True when maxPages stopped the walk before the start date / end of history. */
  truncated: boolean;
  /** Oldest order date seen (YYYY-MM-DD) - how far back the walk actually reached. */
  oldestSeen: string | null;
  /** True when the walk reached the END of the history Uber Eats serves (no older orders exist). */
  reachedEnd: boolean;
}

/**
 * Uber Eats' website serves a bounded history (about two years). When the walk reached its
 * end and the caller asked for dates before it, say so - an empty answer for 2023 must not
 * read as "no orders in 2023".
 */
export function historyWarning(
  res: { reachedEnd: boolean; oldestSeen: string | null },
  startDate?: string,
  /** Where the ORDER search actually started (transactions look back before startDate). */
  searchStart = startDate,
): string | null {
  if (!res.reachedEnd || !res.oldestSeen) return null;
  if (startDate && startDate < res.oldestSeen) {
    return (
      `Uber Eats serves order history back to ${res.oldestSeen} only; nothing before that date can be read ` +
      `here (Uber's data download at help.uber.com covers older orders).`
    );
  }
  if (searchStart && searchStart < res.oldestSeen) {
    return (
      `Lookback incomplete: charges in this range from orders placed before ${res.oldestSeen} (a late tip or ` +
      `refund) cannot be read - Uber Eats' history starts there.`
    );
  }
  return null;
}

export interface EatsTransaction {
  orderId: string;
  store: string;
  orderPlacedAt: string | null;
  /** Local wall-clock time printed on the receipt ("YYYY-MM-DDTHH:mm"). */
  chargedAt: string | null;
  chargedAtText: string | null;
  method: string;
  brand: string | null;
  last4: string | null;
  /** Signed dollars: refunds negative. Null when the receipt printed no amount. */
  amount: number | null;
  /** True when the amount was not printed and was taken from the receipt total (single charge). */
  amountInferred: boolean;
  kind: "charge" | "refund";
  /** A later charge equal to the order's tip - Uber bills tips added after delivery separately. */
  isTip: boolean;
  info: string | null;
}

export class UberEatsClient {
  constructor(
    private readonly rpc: UberEatsRpc,
    readonly timeZone = process.env.UBEREATS_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {}

  /** Signed in when the order history answers; the signed-out failure is typed by the RPC layer. */
  async checkSignedIn(): Promise<SignInCheck> {
    try {
      await this.rpc.call(OPS.pastOrders, { lastWorkflowUUID: "" });
      return { authenticated: true };
    } catch (e) {
      if (e instanceof UberEatsError && e.code === "NOT_SIGNED_IN") return { authenticated: false, message: e.message };
      throw e;
    }
  }

  /** One page of history. Pages are chained by the LAST order id of the previous page. */
  async pastOrdersPage(lastOrderId = ""): Promise<{ orders: EatsOrder[]; ids: string[]; hasMore: boolean }> {
    return parseOrdersPage(await this.rpc.call(OPS.pastOrders, { lastWorkflowUUID: lastOrderId }));
  }

  orderDate(o: EatsOrder): string | null {
    return localDate(o.placedAt ?? o.completedAt, this.timeZone);
  }

  /**
   * Walk history newest-first, keeping orders placed within [startDate, endDate].
   * The response's `paginationData.nextCursor` does NOT page (it returns page 1 again);
   * the web app pages with `lastWorkflowUUID` = the previous page's last order id.
   */
  async listOrders(opts: ListOrdersOptions = {}): Promise<ListOrdersResult> {
    const maxPages = opts.maxPages ?? 60;
    const seen = new Set<string>();
    const orders: EatsOrder[] = [];
    let last = "";
    let pages = 0;
    let oldestSeen: string | null = null;
    let reachedEnd = false;
    while (pages < maxPages) {
      const page = await this.pastOrdersPage(last);
      pages++;
      opts.onPage?.(pages, orders.length);
      let fresh = 0;
      let pastStart = false;
      for (const o of page.orders) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        fresh++;
        const date = this.orderDate(o);
        if (date && (!oldestSeen || date < oldestSeen)) oldestSeen = date;
        if (opts.startDate && date && date < opts.startDate) {
          pastStart = true;
          continue;
        }
        if (opts.endDate && date && date > opts.endDate) continue;
        if (!storeMatches(o, opts.store)) continue;
        orders.push(o);
      }
      if (!page.hasMore || fresh === 0 || page.ids.length === 0) {
        reachedEnd = true;
        break;
      }
      if (pastStart) break; // history is newest-first: everything after this is older
      last = page.ids[page.ids.length - 1];
    }
    const truncated =
      !reachedEnd && pages >= maxPages && !(opts.startDate && oldestSeen && oldestSeen < opts.startDate);
    return { orders, pages, truncated, oldestSeen, reachedEnd };
  }

  async getOrder(orderId: string): Promise<EatsOrder> {
    const data = await this.rpc.call<{ order?: unknown }>(OPS.pastOrder, { workflowUuid: orderId });
    if (!data?.order) throw new UberEatsError("API_ERROR", `order ${orderId} not found`, false, OPS.pastOrder);
    return parseOrder(data.order);
  }

  async getReceipt(orderId: string): Promise<EatsReceipt> {
    const data = await this.rpc.call<{ receiptData?: string }>(OPS.receipt, { workflowUuid: orderId });
    if (!data?.receiptData) {
      throw new UberEatsError("API_ERROR", `no receipt returned for order ${orderId}`, false, OPS.receipt);
    }
    return parseReceiptHtml(data.receiptData, orderId);
  }

  /** Receipts for many orders, a few at a time (each is one small RPC). */
  receiptsFor(orderIds: string[], concurrency = 4): Promise<(EatsReceipt | { orderId: string; error: string })[]> {
    return mapLimit(orderIds, concurrency, async (id) => {
      try {
        return await this.getReceipt(id);
      } catch (e) {
        if (e instanceof UberEatsError && e.code === "NOT_SIGNED_IN") throw e;
        return { orderId: id, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /**
   * One row per card charge / refund - the shape of a card statement.
   * Charges can post days after the order (tips, refunds), so orders are searched from
   * `lookbackDays` before startDate, then each charge is kept when ITS date is in range.
   */
  async listTransactions(opts: ListOrdersOptions & { lookbackDays?: number; concurrency?: number } = {}): Promise<{
    transactions: EatsTransaction[];
    ordersScanned: number;
    pages: number;
    truncated: boolean;
    reachedEnd: boolean;
    oldestSeen: string | null;
    receiptErrors: { orderId: string; error: string }[];
  }> {
    const lookback = opts.lookbackDays ?? 7;
    const search = await this.listOrders({
      ...opts,
      startDate: opts.startDate ? addDays(opts.startDate, -lookback) : undefined,
    });
    const receipts = await this.receiptsFor(
      search.orders.map((o) => o.id),
      opts.concurrency ?? 4,
    );
    const transactions: EatsTransaction[] = [];
    const receiptErrors: { orderId: string; error: string }[] = [];
    search.orders.forEach((order, i) => {
      const r = receipts[i];
      if ("error" in r) {
        receiptErrors.push(r);
        return;
      }
      transactions.push(...toTransactions(order, r));
    });
    const inRange = transactions.filter((t) => {
      const day = t.chargedAt?.slice(0, 10) ?? localDate(t.orderPlacedAt, this.timeZone);
      // an undated charge cannot be shown to be in range - keep it only for an unbounded query
      if (!day) return !opts.startDate && !opts.endDate;
      return (!opts.startDate || day >= opts.startDate) && (!opts.endDate || day <= opts.endDate);
    });
    inRange.sort((a, b) => (b.chargedAt ?? "").localeCompare(a.chargedAt ?? ""));
    return {
      transactions: inRange,
      ordersScanned: search.orders.length,
      pages: search.pages,
      truncated: search.truncated,
      reachedEnd: search.reachedEnd,
      oldestSeen: search.oldestSeen,
      receiptErrors,
    };
  }
}

export function toTransactions(order: EatsOrder, receipt: EatsReceipt): EatsTransaction[] {
  const tip = order.fare.tip || receipt.fareLines.find((l) => l.key === "tip")?.amount || 0;
  return receipt.payments.map((p) => ({
    orderId: order.id,
    store: order.store.name || receipt.storeName || "",
    orderPlacedAt: order.placedAt,
    chargedAt: p.chargedAt,
    chargedAtText: p.chargedAtText,
    method: p.method,
    brand: p.brand,
    last4: p.last4,
    amount: p.amount,
    amountInferred: p.amountInferred,
    kind: p.kind,
    isTip: p.kind === "charge" && p.index > 0 && tip > 0 && p.amount !== null && round2(p.amount) === round2(tip),
    info: p.info,
  }));
}
