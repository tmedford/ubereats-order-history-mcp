#!/usr/bin/env node
/**
 * Turn raw captures (./captures, from scripts/capture.mjs) into anonymised test fixtures.
 *
 *   node scripts/scrub-fixtures.mjs <orderId>[,<orderId>...] --receipt name=<orderId> ...
 *
 * Removes: the account holder's names, email, phone and user/consumer ids, the delivery
 * address, courier names, every URL (tracking links carry tokens), styles/scripts, and
 * real card digits. Stores, items and prices stay - they are what the tests assert on.
 * Aborts if anything on the known-PII list survives.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";

const CAP = join(process.cwd(), "captures");
const OUT = join(process.cwd(), "tests", "fixtures");
mkdirSync(OUT, { recursive: true });

const orderIds = (process.argv[2] ?? "").split(",").filter(Boolean);
const receipts = process.argv
  .slice(3)
  .filter((a) => a.includes("="))
  .map((a) => a.split("="));

// ---- gather every raw order and the PII they reveal ------------------------------------
const orders = new Map();
for (const f of readdirSync(CAP).filter((f) => f.startsWith("past-orders-"))) {
  const d = JSON.parse(readFileSync(join(CAP, f), "utf8"));
  for (const id of d.orderUuids) orders.set(id, d.ordersMap[id]);
}
const pii = new Set();
const ids = new Set();
const add = (v) => typeof v === "string" && v.trim().length >= 3 && pii.add(v.trim());
for (const o of orders.values()) {
  for (const [uuid, c] of Object.entries(o.customerInfos ?? {})) {
    ids.add(uuid);
    for (const k of ["firstName", "lastName", "nickName", "email", "phone"]) add(c?.[k]);
  }
  const walk = (x) => (typeof x === "string" ? add(x) : x && typeof x === "object" && Object.values(x).forEach(walk));
  walk(o.deliveryAddress);
  add(o.courierInfo?.name);
  add(o.baseEaterOrder?.creatorDisplayName);
  for (const it of o.baseEaterOrder?.shoppingCart?.items ?? []) if (it.consumerUuid) ids.add(it.consumerUuid);
}
// names and drop-off addresses printed on receipts
for (const f of readdirSync(CAP).filter((f) => f.startsWith("receipt-"))) {
  const h = readFileSync(join(CAP, f), "utf8");
  const grab = (tid) =>
    h
      .match(new RegExp(`data-testid="${tid}\\s*"[^>]*>([\\s\\S]*?)<\\/`))?.[1]
      ?.replace(/<[^>]+>/g, "")
      .trim();
  add(grab("header_message")?.match(/, (.+)$/)?.[1]);
  add(grab("driverInfo_title")?.replace(/^(Delivered|Picked up) by\s+/i, ""));
  add(grab("address_point_1_address"));
  // the older table template has no data-testid hooks: take the greeting's name from text
  for (const m of h.matchAll(/Thanks for (?:ordering|tipping), ([A-Z][^<,!]{1,40})/g)) add(m[1].replace(/\.$/, ""));
}
// Any card digits found are replaced deterministically (first card seen -> 1111, next -> 2222, ...),
// so fixtures keep "two different cards" without shipping real numbers.
const cards = new Map();
const fakeCard = (d) => {
  if (!cards.has(d)) cards.set(d, String((cards.size % 9) + 1).repeat(4));
  return cards.get(d);
};
const piiList = [...pii].sort((a, b) => b.length - a.length);

function scrubText(s) {
  let out = s;
  for (const id of ids) out = out.split(id).join("00000000-0000-4000-8000-000000000001");
  for (const p of piiList)
    out = out
      .split(p)
      .join(
        /@/.test(p)
          ? "alex@example.com"
          : /\d{3}.*\d{4}/.test(p) && !/[a-z]{3}/i.test(p)
            ? "+15555550100"
            : /\d/.test(p)
              ? "100 Example St, New York, NY 10001, USA"
              : "Alex",
      );
  out = out.replace(/(••••|\*{4}|x{4})\s*(\d{4})/gi, (_, dots, d) => `${dots}${fakeCard(d)}`);
  return out;
}

function scrubHtml(h) {
  return scrubText(
    h
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s(href|src|srcset|background)="[^"]*"/gi, ' $1="#"')
      .replace(/\sstyle="[^"]*"/gi, "")
      .replace(/https?:\/\/[^\s"'<>)]+/g, "https://example.invalid/"),
  );
}

function check(name, text) {
  const leaks = piiList.filter((p) => text.includes(p)).concat([...ids].filter((i) => text.includes(i)));
  for (const d of cards.keys()) if (new RegExp(`(••••|\\*{4})${d}`).test(text)) leaks.push(`card ${d.slice(0, 1)}...`);
  if (leaks.length) {
    console.error(`LEAK in ${name}: ${leaks.map((l) => JSON.stringify(l.slice(0, 12) + "...")).join(", ")}`);
    process.exit(1);
  }
}

/** Drop the UI render payloads (itemPayloads, userGroupedItems) - the parser never reads them. */
function slim(o) {
  const c = structuredClone(o);
  delete c.baseEaterOrder.itemPayloads;
  delete c.baseEaterOrder.userGroupedItems;
  return c;
}

if (orderIds.length) {
  const missing = orderIds.filter((id) => !orders.has(id));
  if (missing.length) throw new Error(`not in captures: ${missing.join(", ")}`);
  const page = {
    ordersMap: Object.fromEntries(orderIds.map((id) => [id, slim(orders.get(id))])),
    orderUuids: orderIds,
    paginationData: { nextCursor: "{}" },
    meta: { hasMore: true },
  };
  const text = scrubText(JSON.stringify(page, null, 2));
  check("past-orders-page.json", text);
  writeFileSync(join(OUT, "past-orders-page.json"), text);
  const one = scrubText(JSON.stringify({ order: slim(orders.get(orderIds[0])) }, null, 2));
  check("past-order.json", one);
  writeFileSync(join(OUT, "past-order.json"), one);
}
for (const [name, id] of receipts) {
  const text = scrubHtml(readFileSync(join(CAP, `receipt-${id}.html`), "utf8"));
  check(name, text);
  writeFileSync(join(OUT, `receipt-${name}.html`), text);
}
console.log(`wrote fixtures to ${OUT} (${piiList.length} PII strings, ${ids.size} ids scrubbed)`);
