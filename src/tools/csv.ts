/** Flat CSV views of orders, line items and card transactions. */

import type { EatsOrder } from "../ubereats/orders";
import type { EatsTransaction } from "../ubereats/client";

export type CsvKind = "orders" | "items" | "transactions";

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(v) : String(v);
  // Neutralise spreadsheet formula injection from merchant-controlled text.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export function ordersCsv(orders: EatsOrder[]): string {
  return toCsv(
    [
      "order_id",
      "placed_at",
      "completed_at",
      "status",
      "store",
      "store_address",
      "category",
      "items",
      "subtotal",
      "tax",
      "delivery_fee",
      "service_fee",
      "tip",
      "discounts",
      "total",
      "currency",
      "items_match_subtotal",
    ],
    orders.map((o) => [
      o.id,
      o.placedAt,
      o.completedAt,
      o.status,
      o.store.name,
      o.store.address,
      o.category,
      o.itemCount,
      o.fare.subtotal,
      o.fare.tax,
      o.fare.deliveryFee,
      o.fare.serviceFee,
      o.fare.tip,
      o.fare.discounts,
      o.fare.total,
      o.currency,
      o.itemsMatchSubtotal,
    ]),
  );
}

export function itemsCsv(orders: EatsOrder[]): string {
  return toCsv(
    [
      "order_id",
      "placed_at",
      "store",
      "item",
      "options",
      "quantity",
      "unit_price",
      "options_price",
      "line_total",
      "special_instructions",
    ],
    orders.flatMap((o) =>
      o.items.map((i) => [
        o.id,
        o.placedAt,
        o.store.name,
        i.title,
        i.options
          .filter((op) => op.quantity !== op.includedQuantity || op.price !== 0 || op.quantity > 0)
          .map(
            (op) =>
              `${op.group}: ${op.quantity === 0 ? "no " : ""}${op.title}${op.quantity > 1 ? ` x${op.quantity}` : ""}`,
          )
          .join("; "),
        i.quantity,
        i.unitPrice,
        i.optionsPrice,
        i.lineTotal,
        i.specialInstructions,
      ]),
    ),
  );
}

export function transactionsCsv(txns: EatsTransaction[]): string {
  return toCsv(
    [
      "charged_at",
      "amount",
      "amount_inferred",
      "kind",
      "is_tip",
      "card_brand",
      "card_last4",
      "payment_method",
      "store",
      "order_id",
      "order_placed_at",
      "info",
    ],
    txns.map((t) => [
      t.chargedAt,
      t.amount,
      t.amountInferred,
      t.kind,
      t.isTip,
      t.brand,
      t.last4,
      t.method,
      t.store,
      t.orderId,
      t.orderPlacedAt,
      t.info,
    ]),
  );
}
