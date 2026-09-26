# Uber Eats Order History MCP

A **read-only** [MCP](https://modelcontextprotocol.io) server that gives Claude (or any MCP client) your Uber Eats order history: orders, every line item and option, the full fare breakdown, and **which card paid how much, when** - including tips billed hours after delivery and refunds.

It signs in with the session **your Google Chrome already has** (no password, ever), drives your real installed Chrome, and reads Uber Eats' **own data feeds** - the same JSON and receipt documents the website renders from - instead of scraping pages.

> Unofficial. Uses the private web endpoints the ubereats.com website itself uses; Uber can change them at any time. Not affiliated with Uber.

## Why

Uber Eats receipt emails often omit the items (store orders like Target show only a total), and the "download PDF" link needs a signed-in browser. Card statements show one amount per charge and nothing else. This server closes that gap:

| You want | Tool | Source |
|---|---|---|
| What did I order, from where, and what did each part cost? | `get_ubereats_orders` | order-history feed (JSON) |
| Everything about one order, including each card charge | `get_ubereats_order_details` | order + receipt |
| Which Uber Eats order is this card charge? | `get_ubereats_transactions` | receipts: card, amount, time per charge |
| A spreadsheet | `export_ubereats_csv` | orders / items / transactions |
| Am I signed in? | `check_ubereats_auth_status` | order-history feed |

## How it works

```
Claude ──stdio──> ubereats-order-history-mcp
                      │  1. copy ubereats.com + uber.com cookies out of Chrome (macOS Keychain
                      │     consent; never logged) into the connector's own profile
                      │  2. launch the REAL installed Chrome (headless) with those cookies,
                      │     or attach to the one another Claude session already launched
                      │  3. open https://www.ubereats.com/robots.txt (tiny, same origin)
                      └─ 4. fetch() Uber Eats' own RPCs from that page:
                              POST /_p/api/getPastOrdersV1           order history, 10/page
                              POST /_p/api/getPastOrderV1            one order
                              POST /_p/api/getReceiptByWorkflowUuidV1 the receipt
```

- **Two receipt layouts.** Receipts from about Sep 2025 carry `data-testid` hooks. Older ones use Uber's classic table template with no hooks, which is parsed from its fixed text order. Both give the same fields, and on a real account every receipt's charges add up to its total.
- **Root sources, not scraping.** Orders come from `getPastOrdersV1` JSON: items with unit prices in cents, option add-ons, and fare lines keyed like `eats_fare.subtotal`, `eats.tax.base` and `eats_fare.tip`. Card charges come from the receipt document, parsed by its stable `data-testid` hooks (`payments_0_Card.String`, `payments_0_AmountCharged`, ...). No layout or CSS selectors are used.
- **Checked against itself.** Every order reports `itemsMatchSubtotal`: whether (unit price + add-ons) × quantity reproduces Uber's subtotal. Where a receipt prints exact line amounts (restaurants), those win. Fare lines are summed into subtotal / tax / fees / tip / discounts that add up to the total.
- **Latest browser, same identity.** The installed Chrome is driven directly, with its real version in the user agent. The cookies belong to that Chrome, and Uber's firewall rejects Playwright's bundled Chromium.
- **Reuse, then repair.** Chrome's session is copied in every time the browser opens. Before each tool call a sign-in guard checks the session. If it has expired, the guard re-imports Chrome's cookies and retries with backoff; if that fails, it returns a typed `NOT_SIGNED_IN` error, **never** an empty "success".
- **Retries where they help.** Rate limits (429), 5xx errors, a Cloudflare challenge page and a crashed page are retried with backoff, on a fresh page for a challenge. Signed-out and bad-input errors are not.
- **One browser for every Claude session.** The first server launches Chrome with a random local debugging port and a lockfile; others attach to that exact browser (read from its own `DevToolsActivePort`), never to a guessable port.
- **Efficient.** Paging stops as soon as it passes `start_date`. Receipts are fetched 4 at a time and only for orders in range. A 60-day transactions query is about 2–4 seconds.

## Tools

All tools are read-only. Nothing here can order, tip, rate, cancel or pay.

### `get_ubereats_orders`
`start_date`, `end_date` (inclusive `YYYY-MM-DD`, order placed date, local time), `store` (name contains, case- and symbol-insensitive, so `"mcdonalds"` matches `McDonald's®`), `max_pages` (default 60), `include_items` (default true), `include_receipts` (default false; adds each order's card charges).

```json
{
  "id": "b37637a0-18d4-4316-a445-2e62415bb3fb",
  "store": { "name": "Target", "address": "512 2nd Ave, New York, NY 10016" },
  "status": "completed", "category": "GROCERY",
  "placedAt": "2026-09-21T23:09:58.000Z",
  "items": [
    { "title": "Cascade Platinum Dishwasher Detergent Liquid, Fresh (75 fl oz)", "quantity": 1, "unitPrice": 14.39, "lineTotal": 14.39 },
    { "title": "Dealworthy Hdmi High Speed Cable With Ethernet Cable, 6 ft, Black", "quantity": 1, "unitPrice": 10.79, "lineTotal": 10.79 }
  ],
  "fare": { "subtotal": 25.18, "tax": 2.98, "deliveryFee": 0.99, "serviceFee": 7.4, "tip": 0, "discounts": 0, "total": 36.55 },
  "itemsMatchSubtotal": true
}
```

### `get_ubereats_transactions`
One row per card charge or refund, the shape of a card statement. `start_date` (required), `end_date`, `card_last4`, `store`, `lookback_days` (default 7: tips and refunds post after the order).

```json
[
  { "chargedAt": "2026-06-24T09:48", "amount": 22.3,  "brand": "Mastercard",       "last4": "2222", "kind": "charge", "isTip": false, "store": "The Home Depot" },
  { "chargedAt": "2026-06-24T11:50", "amount": 2.56,  "brand": "American Express", "last4": "1111", "kind": "charge", "isTip": true,  "store": "The Home Depot" },
  { "chargedAt": "2026-06-24T17:49", "amount": -6.13, "brand": "Mastercard",       "last4": "2222", "kind": "refund", "isTip": false, "store": "The Home Depot" }
]
```

`chargedAt` is the wall-clock time printed on the receipt (no time zone). A charge the receipt prints without an amount is `null`, unless it is the ONLY such charge on its receipt. Then it is inferred as the receipt total minus the other charges (the whole total for a single-charge receipt), and flagged `amountInferred: true`, so it is never mistaken for an amount Uber printed. On a real account no amounts needed inferring: every receipt printed all of them.

### `get_ubereats_order_details`
`order_id` (UUID), `include_receipt` (default true). Returns the order plus the parsed receipt: payments, fare lines, printed item amounts and options, pickup and drop-off addresses.

### `export_ubereats_csv`
`kind`: `orders` | `items` | `transactions`, plus dates and an optional `output_path` (default `~/Downloads`). Files are written `0600`, and cells are protected against spreadsheet formula injection.

### `check_ubereats_auth_status`
Reports whether the session works; if not, it tries one repair from Chrome first.

## Install

Requirements: **macOS**, **Google Chrome** signed in to [ubereats.com](https://www.ubereats.com), Node 20+.

```bash
git clone https://github.com/tmedford/ubereats-order-history-mcp.git
cd ubereats-order-history-mcp
npm install && npm run build
claude mcp add ubereats-orders -- node "$PWD/dist/index.js"
```

The first run may show a macOS Keychain prompt for "Chrome Safe Storage". That's macOS asking whether this program may read Chrome's cookie key; choose **Allow** (or **Always Allow**).

No browser download is needed: `playwright-core` drives your installed Chrome.

### Configuration (environment, all optional)

| Variable | Default | |
|---|---|---|
| `UBEREATS_TIMEZONE` | system zone | Zone used to turn timestamps into `YYYY-MM-DD` for date filters |
| `UBEREATS_LOCALE` | `en-US` | `localeCode` sent to Uber Eats |
| `UBEREATS_CHROME_PROFILE` | `Default` | Chrome profile to read cookies from (`Profile 1`, ...) |
| `UBEREATS_CHROME_PROFILE_DIR` | | Full path to that profile directory instead |
| `UBEREATS_CHROME_PATH` | `/Applications/Google Chrome.app/...` | Chrome binary to drive |
| `UBEREATS_ORDERS_BROWSER_DATA_DIR` | `~/.ubereats-order-history-mcp/browser-data` | The connector's own browser profile (never Chrome's) |
| `UBEREATS_ORDERS_HEADFUL` | | `1` shows the browser window (debugging) |

## Privacy and security

Enforced in code, and each point is covered by tests:

- **Read-only allowlist.** `ALLOWED_OPERATIONS` in `src/ubereats/rpc.ts` holds the only three operations the server can call: `getPastOrdersV1`, `getPastOrderV1` and `getReceiptByWorkflowUuidV1`. Any other name is refused before a request is made, so nothing can order, tip, rate, cancel or pay.
- **The session never leaves Uber Eats.** The automation page aborts every request that isn't `https://*.ubereats.com`: no trackers, no plaintext, no redirects off-site. There is no telemetry and there are no third-party calls.
- **Cookies**: only `ubereats.com` / `uber.com` cookies are decrypted; Chrome's master key is held in memory for one import only. They are then written into the connector's own **persistent** browser profile, `UBEREATS_ORDERS_BROWSER_DATA_DIR` (default `~/.ubereats-order-history-mcp/browser-data`, forced to `0700`), so the session stays on disk after the server stops, like any browser profile. Delete that directory to remove it; Chrome's own session is untouched. Cookie values are never logged. Chrome's app-bound (`v20`) cookie encryption is refused, not bypassed.
- **Errors are sanitized.** Anything token-shaped (JWTs, long hex or base64 strings) is stripped from error text before it reaches the client, and error snippets are length-capped.
- **The debugging port** is random, bound to `127.0.0.1`, and attached to only through the owning profile's `DevToolsActivePort` while the owner process is alive. Like any local browser, other programs running as *your* user could reach it while it's open; it's never exposed to the network.
- **Exports** are written `0600` (re-applied when overwriting), with formula-injection protection.
- **No personal data in the repo.** Fixtures are real responses scrubbed by `scripts/scrub-fixtures.mjs`, which fails if a known value survives. On top of that, `scripts/check-leaks.mjs` runs in CI on every push and PR and fails the build on any email, phone number, non-placeholder card number, JWT, session cookie, token or receipt name in any tracked file. `captures/` (raw data from your account) is gitignored.

Found a security issue? See [SECURITY.md](SECURITY.md).

## Limits

- **History depth**: Uber Eats' website serves about two years of orders, and a query that reaches further back returns a warning naming where the history starts. Older orders need Uber's [data download](https://help.uber.com/riders/article/download-your-data).
- **Missing receipts**: occasionally Uber has no receipt for an order; it's reported in `receiptErrors`, never silently dropped.
- **Your account only**: orders placed from someone else's Uber account (even on your card) aren't visible.
- **Group orders** you didn't create show `isOrderCreator: false`.
- macOS only (the Chrome cookie decryption uses the macOS Keychain).

## Development

```bash
npm test                 # unit tests (fixtures, no network)
npm run lint && npm run typecheck && npm run check:leaks
npm run test:e2e         # END-TO-END against your real account through the MCP protocol
```

`test:e2e` spawns the built server over stdio and calls every tool. It also checks that two servers share one browser, and that a server with no Chrome session returns `NOT_SIGNED_IN`. Pin exact values with `E2E_ORDER_ID`, `E2E_ORDER_DATE`, `E2E_ORDER_TOTAL`, `E2E_ORDER_ITEMS`, `E2E_CARD_LAST4` and `E2E_SPLIT_ORDER_DATE`.

When Uber changes a response shape, refresh the fixtures from your own account:

```bash
npm run build && node scripts/capture.mjs 3 12         # raw → ./captures (gitignored)
node scripts/scrub-fixtures.mjs <orderIds,...> grocery=<id> split-charges=<id> ...
```

## Credits

The Chrome cookie import, shared-browser election and sign-in guard are ported from [tmedford/amazon-order-history-csv-download-mcp](https://github.com/tmedford/amazon-order-history-csv-download-mcp), a fork of [marcusquinn/amazon-order-history-csv-download-mcp](https://github.com/marcusquinn/amazon-order-history-csv-download-mcp) (MIT). See [CREDITS.md](CREDITS.md).

MIT licensed.
