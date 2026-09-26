/**
 * Parse the receipt that getReceiptByWorkflowUuidV1 returns.
 *
 * The receipt is the only source that says WHICH CARD paid and WHEN each charge landed -
 * the order feed has items and fees but no payment. It arrives as a server-rendered HTML
 * document (the same one the "View receipt" panel shows) whose meaningful nodes carry
 * stable data-testid hooks, so parsing keys on those hooks, never on layout or CSS:
 *
 *   payments_<n>_Card.String     "American Express ••••1234"
 *   payments_<n>_AmountCharged   "$22.30" / "-$6.13"
 *   payments_<n>_date_time       "6/24/26 9:48 AM"
 *   payments_<n>_Info            "" / "Refund"
 *   fare_line_item_label_<key> / fare_line_item_amount_<key>
 *   shoppingCart_item_title_<id> / _quantity_<id> / _amount_<id>
 *   address_point_<n>_time / _address, driverInfo_title, header_*, total_fare_*,
 *   notification_<n>_text
 *
 * One order can carry several charges on different cards: the order itself, a tip added
 * later (often a separate card charge hours after delivery) and refunds. Each is its own
 * payment row, which is exactly what a bank or card statement shows.
 */

import { HTMLElement, parse } from "node-html-parser";
import { round2 } from "./orders";

export interface ReceiptPayment {
  index: number;
  /** As printed, e.g. "American Express ••••1234", "Uber Cash". */
  method: string;
  brand: string | null;
  last4: string | null;
  /**
   * Signed dollars: refunds are negative. Null when the receipt prints no amount for the
   * row - except that a receipt with ONE payment row and no amount gets the receipt total,
   * flagged by `amountInferred` (seen on real receipts: "Card ••••1234", date, no amount).
   */
  amount: number | null;
  amountInferred: boolean;
  chargedAtText: string | null;
  /** Local wall-clock time as printed ("YYYY-MM-DDTHH:mm", no zone), or null. */
  chargedAt: string | null;
  info: string | null;
  kind: "charge" | "refund";
}

export interface ReceiptFareLine {
  key: string;
  label: string;
  amount: number;
}

export interface EatsReceipt {
  orderId: string;
  /** "current" = data-testid template (from ~Sep 2025); "legacy" = the older table template. */
  layout: "current" | "legacy";
  headline: string | null;
  storeName: string | null;
  headerDate: string | null;
  headerTime: string | null;
  total: number | null;
  fareLines: ReceiptFareLine[];
  items: { id: string; title: string; quantity: number | null; amount: number | null; options: string[] }[];
  payments: ReceiptPayment[];
  pickup: { time: string | null; address: string | null } | null;
  dropoff: { time: string | null; address: string | null } | null;
  courier: string | null;
  notifications: string[];
}

/** "$1,234.56" -> 1234.56, "-$0.99" -> -0.99, "" -> null. */
export function parseMoney(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/\s/g, "").match(/^(-|−)?[^\d-−]*([\d,]+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = parseFloat(m[2].replace(/,/g, ""));
  return round2(m[1] ? -n : n);
}

/** "9/22/26 6:10 AM" -> "2026-09-22T06:10" (local wall clock as printed). */
export function parseChargeTime(text: string | null | undefined): string | null {
  const m = text?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return null;
  const [, mo, d, y, h, min, ampm] = m;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  let hour = Number(h) % 12;
  if (ampm.toUpperCase() === "PM") hour += 12;
  const pad = (n: number | string) => String(n).padStart(2, "0");
  return `${year}-${pad(mo)}-${pad(d)}T${pad(hour)}:${min}`;
}

/**
 * "American Express ••••1234" -> { brand: "American Express", last4: "1234" }.
 * Also "Visa ••••1234 (Joined Card)" (a card shared from another Uber account) and
 * user-nicknamed cards ("House ••••1234") - the brand is whatever label Uber prints.
 */
export function parseCard(method: string): { brand: string | null; last4: string | null } {
  const m = method.match(/^(.*?)\s*(?:[•*·●]+|x{2,}|ending in)\s*(\d{4})\s*(?:\(([^)]*)\))?\s*$/i);
  if (!m) return { brand: method.trim() || null, last4: null };
  return { brand: m[1].trim() || m[3]?.trim() || null, last4: m[2] };
}

/**
 * Fill ONE missing charge amount from the receipt total: the single-payment case takes the
 * total; with several payments the missing one is total minus the others. Flagged, never
 * silent. With two or more missing amounts nothing can be inferred.
 */
export function inferMissingAmount(payments: ReceiptPayment[], total: number | null): void {
  const missing = payments.filter((p) => p.amount === null);
  if (missing.length !== 1 || total === null) return;
  const known = payments.reduce((s, p) => s + (p.amount ?? 0), 0);
  missing[0].amount = round2(total - known);
  missing[0].amountInferred = true;
  if (missing[0].amount < 0) missing[0].kind = "refund";
}

function newPayment(
  index: number,
  method: string,
  amount: number | null,
  chargedAtText: string | null,
  info: string | null,
): ReceiptPayment {
  return {
    index,
    method,
    ...parseCard(method),
    amount,
    amountInferred: false,
    chargedAtText,
    chargedAt: parseChargeTime(chargedAtText),
    info,
    kind: (amount ?? 0) < 0 || /refund/i.test(info ?? "") ? "refund" : "charge",
  };
}

/** Text of every innermost cell/block, in document order - the legacy template's content. */
export function textCells(root: HTMLElement): string[] {
  const cells: string[] = [];
  const walk = (node: HTMLElement) => {
    for (const child of node.childNodes) {
      if (!(child instanceof HTMLElement)) continue;
      const tag = child.rawTagName?.toLowerCase();
      if (tag === "style" || tag === "script" || tag === "head") continue;
      const leaf = ["td", "div", "span", "p"].includes(tag) && child.querySelectorAll("td,div,span,p").length === 0;
      if (leaf) {
        const t = child.textContent
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (t) cells.push(t);
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return cells;
}

const MONEY = /^(-|−)?\$[\d,]+(\.\d+)?$/;
const CHARGE_TIME = /^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*[AP]M$/i;

/**
 * The older receipt template (roughly before September 2025) has no data-testid hooks: it
 * is Uber's classic table email. Its text cells come in a fixed order, verified on real
 * receipts:
 *   <total> | <Month D, YYYY> | Thanks for ..., <name> | Here's your receipt for <store>. |
 *   Total | <total> | [savings line] |
 *   ( <qty> | <title> | [options...] | <line $> | <$ /pc> )* |
 *   Subtotal | <$> | ( <label> | <$> )* |
 *   Payments | ( <method> | <M/D/YY h:mm AM> | [info] | <$> )*
 */
export function parseLegacyReceipt(root: HTMLElement, orderId: string): EatsReceipt {
  const cells = textCells(root);
  const at = (label: string, from = 0) => cells.findIndex((c, i) => i >= from && c === label);
  const iTotal = at("Total");
  // The fare section opens with "Subtotal" on a normal receipt and "Meal Fare" on an UPDATED
  // one (after a refund or a tip); whichever comes first after the total.
  const iSubtotal = (() => {
    const hits = ["Subtotal", "Item Subtotal", "Meal Fare"]
      .map((l) => at(l, Math.max(0, iTotal)))
      .filter((i) => i >= 0);
    return hits.length ? Math.min(...hits) : -1;
  })();
  const iPayments = at("Payments", Math.max(0, iSubtotal));
  const sub = cells.find((c) => /receipt for /i.test(c)) ?? null;

  const items: EatsReceipt["items"] = [];
  const notes: string[] = []; // "The tip has been processed", "You saved $3.54 ..."
  if (iTotal >= 0 && iSubtotal > iTotal) {
    let cur: EatsReceipt["items"][number] | null = null;
    for (let i = iTotal + 2; i < iSubtotal; i++) {
      const c = cells[i];
      if (/^\d+$/.test(c) && i + 1 < iSubtotal && !MONEY.test(cells[i + 1])) {
        cur = { id: `legacy-${items.length}`, title: cells[i + 1], quantity: Number(c), amount: null, options: [] };
        items.push(cur);
        i++;
      } else if (!cur) {
        if (!MONEY.test(c)) notes.push(c); // banners before the first item
      } else if (/\/pc$/.test(c)) {
        continue;
      } else if (MONEY.test(c) && cur.amount === null) {
        cur.amount = parseMoney(c);
      } else if (!MONEY.test(c)) {
        cur.options.push(c);
      }
    }
  }

  const fareLines: ReceiptFareLine[] = [];
  if (iSubtotal >= 0) {
    const end = iPayments > iSubtotal ? iPayments : cells.length;
    for (let i = iSubtotal; i + 1 < end; i++) {
      if (MONEY.test(cells[i]) || !MONEY.test(cells[i + 1])) continue;
      const label = cells[i];
      const key =
        label === "Subtotal"
          ? "item_subtotal"
          : label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "_")
              .replace(/^_|_$/g, "");
      fareLines.push({ key, label, amount: parseMoney(cells[i + 1]) as number });
      i++;
    }
  }

  // Each charge is anchored on its timestamp cell: <method> | <time> | <amount> | [info].
  // "Refund" comes AFTER the amount in this template.
  const payments: ReceiptPayment[] = [];
  if (iPayments >= 0) {
    const times: number[] = [];
    for (let i = iPayments + 1; i < cells.length; i++) if (CHARGE_TIME.test(cells[i])) times.push(i);
    times.forEach((t, n) => {
      const stop = n + 1 < times.length ? times[n + 1] - 1 : cells.length;
      let amount: number | null = null;
      const info: string[] = [];
      for (let i = t + 1; i < stop; i++) {
        const c = cells[i];
        if (MONEY.test(c) && amount === null) amount = parseMoney(c);
        else if (!MONEY.test(c) && c.length <= 40 && !/^visit |invoice/i.test(c)) info.push(c);
      }
      payments.push(newPayment(payments.length, cells[t - 1], amount, cells[t], info.join(" ") || null));
    });
  }
  const total = iTotal >= 0 ? parseMoney(cells[iTotal + 1]) : null;
  inferMissingAmount(payments, total);

  const headerDate = cells.find((c) => /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(c)) ?? null;
  return {
    orderId,
    layout: "legacy",
    headline: cells.find((c) => /^Thanks for /i.test(c)) ?? null,
    storeName: sub?.match(/receipt for (.+?)\.?$/i)?.[1]?.trim() ?? null,
    headerDate,
    headerTime: null,
    total,
    fareLines,
    items,
    payments,
    pickup: null,
    dropoff: null,
    courier: null,
    notifications: notes,
  };
}

export function parseReceiptHtml(html: string, orderId: string): EatsReceipt {
  const root = parse(html);
  if (!root.querySelector("[data-testid], [data_testid]")) return parseLegacyReceipt(root, orderId);
  // testid -> text; some ids carry trailing whitespace/newlines in the source
  const byId = new Map<string, string>();
  const repeated = new Map<string, string[]>(); // ids that legitimately repeat (item options)
  const order: string[] = [];
  // Uber's own markup sometimes spells the hook data_testid (seen on payments_N_AmountCharged
  // in split-payment receipts), so both spellings are read.
  for (const el of root.querySelectorAll("[data-testid], [data_testid]")) {
    const id = (el.getAttribute("data-testid") ?? el.getAttribute("data_testid") ?? "").trim();
    if (!id) continue;
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (!repeated.has(id)) repeated.set(id, []);
    repeated.get(id)!.push(text);
    if (byId.has(id)) continue;
    byId.set(id, text);
    order.push(id);
  }
  const get = (id: string): string | null => {
    const v = byId.get(id);
    return v === undefined || v === "" ? null : v;
  };

  const fareLines: ReceiptFareLine[] = [];
  for (const id of order) {
    const m = id.match(/^fare_line_item_label_(.+)$/);
    if (!m) continue;
    const amount = parseMoney(get(`fare_line_item_amount_${m[1]}`));
    if (amount === null) continue;
    fareLines.push({ key: m[1], label: get(id) ?? m[1], amount });
  }

  const items: EatsReceipt["items"] = [];
  for (const id of order) {
    const m = id.match(/^shoppingCart_item_title_(.+)$/);
    if (!m) continue;
    const qty = get(`shoppingCart_item_quantity_${m[1]}`);
    items.push({
      id: m[1],
      title: get(id) ?? "",
      quantity: qty && /^\d+(\.\d+)?$/.test(qty) ? Number(qty) : null,
      amount: parseMoney(get(`shoppingCart_item_amount_${m[1]}`)),
      options: (repeated.get(`shoppingCart_item_option_${m[1]}`) ?? []).filter(Boolean),
    });
  }

  const payments: ReceiptPayment[] = [];
  for (let i = 0; byId.has(`payments_${i}_AmountCharged`) || byId.has(`payments_${i}_Card.String`); i++) {
    const method = get(`payments_${i}_Card.String`) ?? "";
    const amount = parseMoney(get(`payments_${i}_AmountCharged`));
    const info = get(`payments_${i}_Info`);
    payments.push(newPayment(i, method, amount, get(`payments_${i}_date_time`), info));
  }
  const total = parseMoney(get("total_fare_amount"));
  inferMissingAmount(payments, total);

  const point = (n: number) => {
    const time = get(`address_point_${n}_time`);
    const address = get(`address_point_${n}_address`);
    return time || address ? { time, address } : null;
  };
  const notifications: string[] = [];
  for (let i = 0; byId.has(`notification_${i}_text`); i++) {
    const t = get(`notification_${i}_text`);
    if (t) notifications.push(t);
  }
  const sub = get("header_sub_message");
  const storeName = sub?.match(/receipt for (.+?)\.?$/i)?.[1]?.trim() ?? null;
  const courier = get("driverInfo_title")?.replace(/^(Delivered|Picked up) by\s+/i, "") ?? null;

  return {
    orderId,
    layout: "current",
    headline: get("header_message"),
    storeName,
    headerDate: get("header_date"),
    headerTime: get("header_time"),
    total,
    fareLines,
    items,
    payments,
    pickup: point(0),
    dropoff: point(1),
    courier,
    notifications,
  };
}
