/**
 * Normalise one order from getPastOrdersV1 / getPastOrderV1.
 *
 * Source fields (as returned by Uber Eats, 2026):
 *   baseEaterOrder.uuid                      order id (the "workflow uuid" receipts are keyed by)
 *   baseEaterOrder.orderStateChanges[]       CREATED / OFFERED / ASSIGNED / COMPLETED, ISO times
 *   baseEaterOrder.shoppingCart.items[]      title, quantity, price = UNIT price in cents, and
 *                                            customizations[].childOptions.options[] add-ons
 *                                            (price in cents, per unit)
 *   fareInfo.checkoutInfo[]                  {key, label, rawValue (dollars), type credit|debit}
 *   storeInfo                                title, location.address.eaterFormattedAddress
 *
 * Verified against a real account: for every order with multi-quantity lines,
 *   sum((unit price + option add-ons) x quantity) == the "eats_fare.subtotal" line.
 * `itemsMatchSubtotal` reports that check per order, so a shape change shows up as data
 * instead of silently wrong totals.
 */

export interface EatsItemOption {
  group: string;
  title: string;
  quantity: number;
  /** How many come with the item at no charge (e.g. the patty in a burger). */
  includedQuantity: number;
  /** Charged add-on per unit of the item, in dollars: price x (quantity - includedQuantity). */
  price: number;
}

export interface EatsOrderItem {
  id: string;
  title: string;
  quantity: number;
  /** Base price per unit, dollars. */
  unitPrice: number;
  /** Sum of option add-ons per unit, dollars. */
  optionsPrice: number;
  /** Dollars. From the receipt when it prints one, else (unitPrice + optionsPrice) x quantity. */
  lineTotal: number;
  lineTotalSource: "receipt" | "computed";
  options: EatsItemOption[];
  specialInstructions?: string;
}

export interface FareLine {
  key: string;
  label: string;
  /** Signed dollars: charges positive, discounts/credits negative. */
  amount: number;
}

export interface EatsFare {
  lines: FareLine[];
  subtotal: number | null;
  tax: number;
  deliveryFee: number;
  serviceFee: number;
  tip: number;
  /** Negative total of every discount / credit / membership benefit line. */
  discounts: number;
  total: number | null;
}

export type EatsOrderStatus = "completed" | "cancelled" | "in_progress";

export interface EatsOrder {
  id: string;
  store: { id: string; name: string; address: string | null };
  status: EatsOrderStatus;
  /** GROCERY, DEFAULT (restaurant), ... */
  category: string | null;
  fulfillmentType: string | null;
  placedAt: string | null;
  completedAt: string | null;
  currency: string;
  /** False for a group order someone else created. */
  isOrderCreator: boolean;
  items: EatsOrderItem[];
  itemCount: number;
  fare: EatsFare;
  itemsMatchSubtotal: boolean | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

export const cents = (n: unknown): number => Math.round(Number(n ?? 0)) / 100;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * An option's `price` is per EXTRA unit: a burger's included patty is listed as
 * "1/10 Lb Beef", price 119, quantity 1, defaultQuantity 1 - and costs nothing. Only the
 * quantity above defaultQuantity is charged (verified against the order subtotal).
 */
function toOption(group: Raw, opt: Raw): EatsItemOption {
  const quantity = Number(opt?.quantity ?? 1);
  const includedQuantity = Number(opt?.defaultQuantity ?? 0);
  return {
    group: String(group?.title ?? ""),
    title: String(opt?.title ?? ""),
    quantity,
    includedQuantity,
    price: round2(cents(opt?.price) * Math.max(0, quantity - includedQuantity)),
  };
}

function parseOptions(groups: Raw[] | undefined, out: EatsItemOption[] = []): EatsItemOption[] {
  for (const group of groups ?? []) {
    for (const opt of group?.childOptions?.options ?? []) {
      out.push(toOption(group, opt));
      // nested groups (a combo side's own choices) are charged the same way
      parseOptions(opt?.childCustomizationList, out);
    }
  }
  return out;
}

export function parseItem(item: Raw): EatsOrderItem {
  const quantity = Number(item?.quantity ?? 1);
  const unitPrice = cents(item?.price);
  const options = parseOptions(item?.customizations);
  const optionsPrice = round2(options.reduce((s, o) => s + o.price, 0));
  const out: EatsOrderItem = {
    id: String(item?.shoppingCartItemUuid ?? item?.uuid ?? ""),
    title: String(item?.title ?? "").trim(),
    quantity,
    unitPrice,
    optionsPrice,
    lineTotal: round2((unitPrice + optionsPrice) * quantity),
    lineTotalSource: "computed",
    options,
  };
  const note = String(item?.specialInstructions ?? "").trim();
  if (note) out.specialInstructions = note;
  return out;
}

/** Classify a fare line key into the summary bucket it belongs to. */
export function fareBucket(line: FareLine): keyof Omit<EatsFare, "lines"> | null {
  const k = line.key.toLowerCase();
  const l = line.label.toLowerCase();
  if (k === "eats_fare.subtotal") return "subtotal";
  if (k === "eats_fare.total") return "total";
  if (k === "eats_fare.tip" || /(^|\.)tip$/.test(k) || l === "tip") return "tip";
  if (line.amount < 0 || /discount|promotion|benefit|credit|offer/.test(k)) return "discounts";
  if (/tax/.test(k) || /\btax/.test(l)) return "tax";
  if (/booking_fee|delivery_fee|delivery fee/.test(k) || l === "delivery fee") return "deliveryFee";
  if (/fee|charges|service/.test(k) || /fee/.test(l)) return "serviceFee";
  return null;
}

export function parseFare(checkoutInfo: Raw[] | undefined): EatsFare {
  const fare: EatsFare = {
    lines: [],
    subtotal: null,
    tax: 0,
    deliveryFee: 0,
    serviceFee: 0,
    tip: 0,
    discounts: 0,
    total: null,
  };
  for (const c of checkoutInfo ?? []) {
    const raw = Math.abs(Number(c?.rawValue ?? 0));
    const line: FareLine = {
      key: String(c?.key ?? ""),
      label: String(c?.label ?? c?.key ?? ""),
      amount: round2(c?.type === "debit" ? -raw : raw),
    };
    fare.lines.push(line);
    const bucket = fareBucket(line);
    if (bucket === "subtotal" || bucket === "total") fare[bucket] = line.amount;
    else if (bucket) fare[bucket] = round2(fare[bucket] + line.amount);
  }
  return fare;
}

function stateTime(order: Raw, type: string): string | null {
  const s = (order?.orderStateChanges ?? []).find((c: Raw) => c?.type === type);
  return s?.stateChangeTime ?? null;
}

export function parseOrder(raw: Raw): EatsOrder {
  const base = raw?.baseEaterOrder ?? {};
  const store = raw?.storeInfo ?? {};
  const items: EatsOrderItem[] = (base?.shoppingCart?.items ?? []).map(parseItem);
  const fare = parseFare(raw?.fareInfo?.checkoutInfo);
  const status: EatsOrderStatus = base?.isCancelled ? "cancelled" : base?.isCompleted ? "completed" : "in_progress";
  return {
    id: String(base?.uuid ?? ""),
    store: {
      id: String(base?.storeUuid ?? store?.uuid ?? ""),
      name: String(store?.title ?? "").trim(),
      address: store?.location?.address?.eaterFormattedAddress ?? store?.location?.address?.address1 ?? null,
    },
    status,
    category: base?.orderCategory ?? null,
    fulfillmentType: base?.fulfillmentType ?? null,
    placedAt: stateTime(base, "CREATED") ?? base?.completedAt ?? base?.lastStateChangeAt ?? null,
    completedAt: base?.completedAt ?? stateTime(base, "COMPLETED"),
    currency: String(base?.currencyCode ?? "USD"),
    isOrderCreator: base?.isOrderCreator !== false,
    items,
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
    fare,
    itemsMatchSubtotal: itemsMatch(items, fare.subtotal),
  };
}

export function itemsMatch(items: EatsOrderItem[], subtotal: number | null): boolean | null {
  if (subtotal === null || items.length === 0) return null;
  return Math.abs(round2(items.reduce((s, i) => s + i.lineTotal, 0)) - subtotal) < 0.005;
}

/**
 * Receipts print the exact charged amount per line for restaurant orders (blank for
 * grocery, which has no add-ons). Where printed, it is authoritative: option pricing has
 * edge cases the order feed does not disambiguate (an included patty listed with its
 * extra-unit price and defaultQuantity 0).
 */
/** Compare item titles as printed on the order feed vs the receipt (marks, case, spacing). */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[®™©'’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function withReceiptLineTotals(
  order: EatsOrder,
  receiptItems: { id: string; title?: string; quantity?: number | null; amount: number | null }[],
): EatsOrder {
  const printed = receiptItems.filter((r) => r.amount !== null);
  if (printed.length === 0) return order;
  // Current receipts key items by the cart-item id; the legacy template has no ids, so its
  // lines join by title (and quantity when printed), each receipt line used at most once.
  const byId = new Map(printed.map((r) => [r.id, r]));
  const used = new Set<(typeof printed)[number]>();
  const items = order.items.map((i) => {
    let hit = byId.get(i.id);
    if (!hit) {
      const t = normalizeTitle(i.title);
      hit = printed.find(
        (r) =>
          !used.has(r) &&
          r.title !== undefined &&
          normalizeTitle(r.title) === t &&
          (r.quantity == null || r.quantity === i.quantity),
      );
    }
    if (!hit || used.has(hit)) return i;
    used.add(hit);
    return { ...i, lineTotal: hit.amount as number, lineTotalSource: "receipt" as const };
  });
  return { ...order, items, itemsMatchSubtotal: itemsMatch(items, order.fare.subtotal) };
}

/** One getPastOrdersV1 page: orders in the order the API lists them (newest first). */
export function parseOrdersPage(data: Raw): { orders: EatsOrder[]; ids: string[]; hasMore: boolean } {
  const ids: string[] = Array.isArray(data?.orderUuids) ? data.orderUuids : Object.keys(data?.ordersMap ?? {});
  const orders = ids
    .map((id) => data?.ordersMap?.[id])
    .filter(Boolean)
    .map(parseOrder);
  return { orders, ids, hasMore: Boolean(data?.meta?.hasMore) };
}
