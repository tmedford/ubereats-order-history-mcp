#!/usr/bin/env node
/**
 * End-to-end test against YOUR real Uber Eats account, through the MCP protocol exactly as
 * Claude uses it: spawns dist/index.js over stdio and calls every tool.
 *
 *   npm run test:e2e
 *
 * Needs Chrome signed in to ubereats.com. Structural checks run on any account; set these
 * to also pin exact values from an order you know:
 *   E2E_ORDER_ID, E2E_ORDER_DATE (YYYY-MM-DD), E2E_ORDER_TOTAL, E2E_ORDER_ITEMS,
 *   E2E_CARD_LAST4, E2E_SPLIT_ORDER_DATE (a day with a separately billed tip)
 *
 * Also checks: two servers at once share ONE browser (one owns, one attaches), and a
 * server pointed at an empty Chrome profile reports NOT_SIGNED_IN instead of an empty list.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SERVER = join(process.cwd(), "dist", "index.js");
const E = process.env;
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  ok " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
};

async function connect(env = {}, name = "e2e") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  const log = [];
  transport.stderr?.on("data", (d) => log.push(String(d)));
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const t0 = Date.now();
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 });
    const payload = JSON.parse(r.content[0].text);
    return { payload, isError: !!r.isError, ms: Date.now() - t0 };
  };
  return { client, call, log, close: () => client.close() };
}

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function main() {
  console.log("1. tool surface + sign-in");
  const a = await connect({}, "e2e-a");
  const tools = (await a.client.listTools()).tools.map((t) => t.name).sort();
  ok(
    JSON.stringify(tools) ===
      JSON.stringify([
        "check_ubereats_auth_status",
        "export_ubereats_csv",
        "get_ubereats_order_details",
        "get_ubereats_orders",
        "get_ubereats_transactions",
      ]),
    `5 read-only tools: ${tools.join(", ")}`,
  );
  const auth = await a.call("check_ubereats_auth_status");
  ok(
    auth.payload.authenticated === true,
    `signed in from Chrome's session (${auth.ms} ms, Chrome ${auth.payload.chromeVersion})`,
  );
  if (!auth.payload.authenticated) throw new Error(`not signed in: ${auth.payload.message}`);

  console.log("2. orders");
  const start = E.E2E_ORDER_DATE ?? daysAgo(90);
  const end = E.E2E_ORDER_DATE ?? today;
  const orders = await a.call("get_ubereats_orders", { start_date: start, end_date: end });
  ok(
    !orders.isError && orders.payload.orderCount > 0,
    `${orders.payload.orderCount} orders ${start}..${end} in ${orders.payload.pages} page(s), ${orders.ms} ms`,
  );
  const all = orders.payload.orders ?? [];
  ok(
    all.every((o) => o.id && o.store?.name && o.fare && Array.isArray(o.items)),
    "every order has id, store, fare, items",
  );
  const sums = all
    .filter((o) => o.fare.total !== null)
    .every((o) => {
      const f = o.fare;
      return Math.abs((f.subtotal ?? 0) + f.tax + f.deliveryFee + f.serviceFee + f.tip + f.discounts - f.total) < 0.01;
    });
  ok(sums, "every order's fare lines add up to its total");
  const matched = all.filter((o) => o.itemsMatchSubtotal === true).length;
  ok(
    matched >= Math.floor(all.length * 0.8),
    `items reproduce the subtotal on ${matched}/${all.length} orders (rest are flagged, not hidden)`,
  );
  const newest = all[0];

  if (E.E2E_ORDER_ID) {
    const o = all.find((x) => x.id === E.E2E_ORDER_ID);
    ok(!!o, `pinned order ${E.E2E_ORDER_ID} found`);
    if (o && E.E2E_ORDER_TOTAL)
      ok(o.fare.total === Number(E.E2E_ORDER_TOTAL), `total ${o.fare.total} = ${E.E2E_ORDER_TOTAL}`);
    if (o && E.E2E_ORDER_ITEMS)
      ok(
        o.items.length === Number(E.E2E_ORDER_ITEMS),
        `${o.items.length} items: ${o.items.map((i) => i.title.slice(0, 30)).join(" | ")}`,
      );
  }

  console.log("3. order details + receipt");
  const id = E.E2E_ORDER_ID ?? newest.id;
  const det = await a.call("get_ubereats_order_details", { order_id: id });
  ok(!det.isError && det.payload.order.id === id, `details for ${id} (${det.ms} ms)`);
  const pays = det.payload.receipt?.payments ?? [];
  ok(pays.length > 0, `receipt charges: ${pays.map((p) => `${p.method} ${p.amount} @ ${p.chargedAt}`).join("; ")}`);
  const paid = Math.round(pays.reduce((s, p) => s + (p.amount ?? 0), 0) * 100) / 100;
  ok(paid === det.payload.receipt.total, `charges sum to the receipt total (${paid})`);
  if (E.E2E_CARD_LAST4)
    ok(
      pays.some((p) => p.last4 === E.E2E_CARD_LAST4),
      `charged to card ending ${E.E2E_CARD_LAST4}`,
    );

  console.log("4. transactions");
  const tDay = E.E2E_SPLIT_ORDER_DATE ?? daysAgo(30);
  const tx = await a.call("get_ubereats_transactions", { start_date: tDay, end_date: E.E2E_SPLIT_ORDER_DATE ?? today });
  ok(!tx.isError, `${tx.payload.transactionCount} charges from ${tDay}, total ${tx.payload.total} (${tx.ms} ms)`);
  ok(
    tx.payload.transactions.every((t) => t.orderId && t.method && t.chargedAt),
    "every charge names its order, payment method and time",
  );
  if (E.E2E_SPLIT_ORDER_DATE)
    ok(
      tx.payload.transactions.some((t) => t.isTip),
      "a separately billed tip is recognised",
    );

  console.log("4b. lookup by store name, and the history floor");
  const hd = await a.call("get_ubereats_orders", { store: "home depot", start_date: daysAgo(400) });
  ok(
    !hd.isError && hd.payload.orders.every((o) => /home depot/i.test(o.store.name)),
    `store filter: ${hd.payload.orderCount} Home Depot orders, no others`,
  );
  const old = await a.call("get_ubereats_orders", {
    start_date: "2015-01-01",
    end_date: "2015-12-31",
    include_items: false,
  });
  ok(
    old.payload.orderCount === 0 && /serves order history back to/.test(old.payload.warning ?? ""),
    `pre-history window warns: ${old.payload.warning?.slice(0, 60)}...`,
  );

  console.log("5. CSV export");
  const dir = mkdtempSync(join(tmpdir(), "ue-e2e-"));
  const csv = await a.call("export_ubereats_csv", {
    kind: "items",
    start_date: start,
    end_date: end,
    output_path: join(dir, "items.csv"),
  });
  const lines = readFileSync(csv.payload.path, "utf8").trim().split("\n");
  ok(lines.length === csv.payload.rows + 1, `${csv.payload.rows} item rows written`);
  rmSync(dir, { recursive: true, force: true });

  console.log("6. two servers share one browser");
  const b = await connect({}, "e2e-b");
  const bAuth = await b.call("check_ubereats_auth_status");
  ok(bAuth.payload.authenticated === true, "second server is signed in too");
  ok(
    /Attached to the shared browser/.test(b.log.join("")) || /Attached to the shared browser/.test(a.log.join("")),
    "one server attached to the other's browser instead of launching a second",
  );
  await b.close();
  await a.close();

  console.log("7. no Chrome session -> typed NOT_SIGNED_IN, never an empty success");
  const empty = mkdtempSync(join(tmpdir(), "ue-e2e-nochrome-"));
  const c = await connect(
    { UBEREATS_CHROME_PROFILE_DIR: empty, UBEREATS_ORDERS_BROWSER_DATA_DIR: join(empty, "profile") },
    "e2e-c",
  );
  const cAuth = await c.call("check_ubereats_auth_status");
  ok(cAuth.payload.authenticated === false, `auth status: not signed in (${cAuth.ms} ms)`);
  const cOrders = await c.call("get_ubereats_orders", { start_date: daysAgo(7) });
  ok(cOrders.isError && cOrders.payload.error === "NOT_SIGNED_IN", `orders -> ${cOrders.payload.error}`);
  await c.close();
  rmSync(empty, { recursive: true, force: true });

  console.log(failures ? `\n${failures} FAILED` : "\nALL E2E CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
