# Changelog

## 0.1.0

First release.

- Tools: `check_ubereats_auth_status`, `get_ubereats_orders`, `get_ubereats_order_details`, `get_ubereats_transactions`, `export_ubereats_csv`.
- Reads Uber Eats' own RPCs (`getPastOrdersV1`, `getPastOrderV1`, `getReceiptByWorkflowUuidV1`) from inside the real installed Chrome, signed in with Chrome's own session.
- Per-charge card, amount and time from receipts, including tips billed after delivery and refunds.
- Sign-in guard with cookie re-import and a typed `NOT_SIGNED_IN` error; retries with backoff for rate limits, 5xx errors and bot challenges.
- One shared browser across concurrent MCP servers.
- Unit tests on scrubbed real fixtures, plus an end-to-end test through the MCP protocol.
