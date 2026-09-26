# Working on this repo

- Read-only connector. Never add an Uber operation that changes state (orders, carts, tips, ratings, payments).
- Data comes from Uber Eats' own RPCs (`src/ubereats/rpc.ts`), run as same-origin `fetch()` inside the real Chrome. Don't scrape rendered pages; the receipt is parsed only through `data-testid` hooks.
- Money is dollars rounded to cents; fare debit lines are negative. Keep `itemsMatchSubtotal` honest: flag mismatches, never paper over them.
- Every new response shape gets a scrubbed fixture (`scripts/capture.mjs` then `scripts/scrub-fixtures.mjs`), and a test that asserts on real values.
- `captures/` holds real personal data and is gitignored. Never commit it and never paste it into issues.
- Before a PR: `npm run typecheck && npm run lint && npm test`, and `npm run test:e2e` when touching the browser, auth or RPC layers.
- Reviews: CodeRabbit is rate-limited. Batch all fixes for a review round into one push, then comment `@coderabbitai review` once. Pushes do not trigger re-reviews on their own. `main` merges need an approving review, which CodeRabbit gives once its comments are resolved (`request_changes_workflow`).
- Code standards: read `.claude/rules/code-standards.md` before writing or reviewing code (rules CS-1…CS-11; every change leaves the codebase the same size or smaller for the same capability).
