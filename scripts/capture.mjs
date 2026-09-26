#!/usr/bin/env node
/**
 * Capture raw responses from YOUR OWN account into ./captures (gitignored) so parser
 * fixtures can be regenerated when Uber Eats changes its response shapes:
 *
 *   npm run build && node scripts/capture.mjs [pages=1] [receipts=5] [extra,order,ids]
 *
 * Then run scripts/scrub-fixtures.mjs to turn them into anonymised test fixtures.
 * Never commit ./captures - it holds your name, addresses and card digits.
 */
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { SharedBrowser } from "../dist/core/shared-browser.js";
import { importChromeCookies } from "../dist/core/chrome-cookies.js";
import { chromeExecutablePath, chromeUserAgent } from "../dist/core/chrome.js";
import { PageTransport, UberEatsRpc } from "../dist/ubereats/rpc.js";

const pages = Number(process.argv[2] ?? 1);
const receipts = Number(process.argv[3] ?? 5);
const extraIds = (process.argv[4] ?? "").split(",").filter(Boolean);
const out = join(process.cwd(), "captures");
mkdirSync(out, { recursive: true });

const browser = new SharedBrowser({
  dataDir:
    process.env.UBEREATS_ORDERS_BROWSER_DATA_DIR ?? join(homedir(), ".ubereats-order-history-mcp", "browser-data"),
  headless: process.env.UBEREATS_ORDERS_HEADFUL !== "1",
  userAgent: chromeUserAgent(),
  executablePath: chromeExecutablePath(),
  onOpen: async (ctx) => {
    const { cookies } = importChromeCookies(["ubereats.com", "uber.com"]);
    if (cookies.length) {
      await ctx.clearCookies({ domain: /(^|\.)(ubereats|uber)\.com$/ });
      await ctx.addCookies(cookies);
    }
  },
});
const rpc = new UberEatsRpc(new PageTransport(browser));
try {
  let last = "";
  const ids = [];
  for (let p = 0; p < pages; p++) {
    const data = await rpc.call("getPastOrdersV1", { lastWorkflowUUID: last });
    writeFileSync(join(out, `past-orders-${p}.json`), JSON.stringify(data, null, 2));
    ids.push(...data.orderUuids);
    console.log(`page ${p}: ${data.orderUuids.length} orders, hasMore=${data.meta?.hasMore}`);
    if (!data.meta?.hasMore) break;
    last = data.orderUuids.at(-1);
  }
  for (const id of [...ids.slice(0, receipts), ...extraIds]) {
    const r = await rpc.call("getReceiptByWorkflowUuidV1", { workflowUuid: id });
    writeFileSync(join(out, `receipt-${id}.html`), r.receiptData);
    console.log(`receipt ${id}: ${r.receiptData.length} bytes`);
  }
  if (ids[0]) {
    const one = await rpc.call("getPastOrderV1", { workflowUuid: ids[0] });
    writeFileSync(join(out, `past-order-${ids[0]}.json`), JSON.stringify(one, null, 2));
  }
} finally {
  await browser.shutdown();
}
