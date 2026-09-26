# Changelog

## 0.2.0

Found by an exhaustive test against a real account: 206 orders and 238 charges, with every Uber Eats row from Sep 2024 onward on three cards in Quicken matched.

- **Legacy receipts:** orders before about Sep 2025 use Uber's older table-based receipt, with no `data-testid` hooks, and previously parsed with **no charges** (130 of 206 orders). A second parser reads that layout in document order: items with amounts, fare lines (both "Subtotal" and "Meal Fare" on updated receipts), each charge including a "Refund" printed after its amount, and notes such as "The tip has been processed".
- **Uber's `data_testid` typo:** split-payment receipts label amounts `data_testid`. They are now read, so no amount is guessed. Before, 52 were "inferred" and 14 were missing.
- **Card labels:** `Visa ••••1234 (Joined Card)` (a card shared from another Uber account) and nicknamed cards like `House ••••1234` now parse.
- **`store` filter** on orders, transactions and CSV export (case- and symbol-insensitive).
- **History-start warning:** asking for dates before the start of the history Uber serves (about two years) now says where it begins, instead of returning an unexplained empty list.
- **Receipt line amounts** on legacy receipts join to order items by title and quantity, so items reproduce the subtotal on 202 of 206 orders. The rest are flagged.
- **Missing amounts:** with several charges, one missing amount is inferred as the total minus the others, and flagged.
- **Tests:** 12 scrubbed real receipt fixtures cover every variation seen; 177 unit tests, plus e2e checks for the store lookup and the history warning.

## 0.1.0

First release.

- Tools: `check_ubereats_auth_status`, `get_ubereats_orders`, `get_ubereats_order_details`, `get_ubereats_transactions`, `export_ubereats_csv`.
- Reads Uber Eats' own RPCs (`getPastOrdersV1`, `getPastOrderV1`, `getReceiptByWorkflowUuidV1`) from inside the real installed Chrome, signed in with Chrome's own session.
- Per-charge card, amount and time from receipts, including tips billed after delivery and refunds.
- Sign-in guard with cookie re-import and a typed `NOT_SIGNED_IN` error; retries with backoff for rate limits, 5xx errors and bot challenges.
- One shared browser across concurrent MCP servers.
- Unit tests on scrubbed real fixtures, plus an end-to-end test through the MCP protocol.
