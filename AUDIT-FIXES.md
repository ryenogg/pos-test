# Test POS audit fixes (October 2026)

This package is a **test-only candidate**. It has not been deployed, and it has not been tested against the shop's actual database or browser storage. Keep the original ZIP and back up the test browser data before trying it.

## Changes

- Drawer payout creation, removal, and shift closure now check localStorage persistence and restore in-memory state on failure.
- Refund restocking now persists stock before the refund record; on a failed refund save it attempts to roll stock back. A browser storage failure during rollback still requires manual reconciliation.
- Product form saves and stock-count/discard changes now check persistence and attempt rollback instead of announcing success after failure.
- Product sync stops before uploads/deletions when newly fetched products cannot be saved locally.
- Browser backup restore stages storage writes and attempts rollback if a write fails; confirmation now explicitly names all replaced collections. Browser localStorage is **not transactional**, so rollback itself can fail.
- SQLite backup migration now stores sale and expense metadata, maps refund receipt numbers to migrated sale IDs, imports shift payouts into `cash_movements`, validates orphan refunds, and retains its existing all-or-nothing database transaction.
- Backend smoke test expanded with a migration/retry/rollback scenario.

## Important limitations / pending work

- Checkout, sales, refunds, expenses, and drawer transactions are **not automatically synchronized** with SQLite. The existing manual sales/expense upload remains experimental.
- Existing product IDs in browser and server are not reconciled. The app does not know which stock count is authoritative. **Do not use product sync on live shop data.**
- Browser expenses are not automatically drawer payouts: only cash actually removed from the drawer should be recorded as a payout. Avoid counting the same expense twice.
- A cash transaction without an assigned open shift is not included in shift totals. This requires a workflow decision before enforcing it.
- Historical expiry-only product records do not contain batch quantities; migration cannot reconstruct them.
- Migration does not import cashier PIN credentials (the backend has a different authentication model). It does not automatically replace local browser data.
- Backend migration is an owner-only import, **not** a full two-way synchronization mechanism. Existing records can be updated by import; only use a disposable test database or a verified backup.
- No dependency installation was possible in the audit environment (npm offline cache incomplete), so integration tests were **added but not executed**. Syntax checks passed.

## Safest test procedure

1. Back up test browser data using the app's Backup feature and back up the test SQLite database.
2. Extract into a **separate directory**. Do not overwrite the currently running test POS yet.
3. Run `npm ci` and `npm test` in that separate directory on a machine with dependencies available.
4. Exercise checkout, partial refunds with restocking, payouts, shift closing, backup restoration using disposable data, and SQLite migration on a disposable database.
5. Only after passing checks, plan a controlled deployment to the **test** service. Never apply to production without separate approval.
