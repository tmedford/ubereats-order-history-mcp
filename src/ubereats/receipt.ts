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

import { parse } from "node-html-parser";
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

/** "American Express ••••1234" -> { brand: "American Express", last4: "1234" }. */
export function parseCard(method: string): { brand: string | null; last4: string | null } {
  const m = method.match(/^(.*?)[\s]*(?:[•*·●]+|x{2,}|ending in)\s*(\d{4})\s*$/i);
  if (!m) return { brand: method.trim() || null, last4: null };
  return { brand: m[1].trim() || null, last4: m[2] };
}

export function parseReceiptHtml(html: string, orderId: string): EatsReceipt {
  const root = parse(html);
  // testid -> text; some ids carry trailing whitespace/newlines in the source
  const byId = new Map<string, string>();
  const repeated = new Map<string, string[]>(); // ids that legitimately repeat (item options)
  const order: string[] = [];
  for (const el of root.querySelectorAll("[data-testid]")) {
    const id = (el.getAttribute("data-testid") ?? "").trim();
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
    const chargedAtText = get(`payments_${i}_date_time`);
    payments.push({
      index: i,
      method,
      ...parseCard(method),
      amount,
      amountInferred: false,
      chargedAtText,
      chargedAt: parseChargeTime(chargedAtText),
      info,
      kind: (amount ?? 0) < 0 || /refund/i.test(info ?? "") ? "refund" : "charge",
    });
  }
  const total = parseMoney(get("total_fare_amount"));
  if (payments.length === 1 && payments[0].amount === null && total !== null) {
    payments[0].amount = total;
    payments[0].amountInferred = true;
  }

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
