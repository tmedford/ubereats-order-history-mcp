# Security policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub's [private vulnerability reporting](https://github.com/tmedford/ubereats-order-history-mcp/security/advisories/new) rather than a public issue. Never include cookies, receipts, order data or anything from `captures/` in a report. Describe the shape of the problem instead.

## What this project guarantees

- **Read-only:** only the operations in `ALLOWED_OPERATIONS` (`src/ubereats/rpc.ts`) can be called.
- **The automation page talks only to `https://*.ubereats.com`.**
- **Session cookies** are read only for `ubereats.com` / `uber.com`, never logged, and stored only in the connector's own `0700` browser profile.
- **Nothing is sent anywhere else:** no telemetry, no third-party services.

A change that weakens any of these must be called out in its PR and needs the maintainer's explicit approval.

## Supported versions

Only the latest release on `main` gets fixes.
