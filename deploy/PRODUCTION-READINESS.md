# Production deployment gate (NOT authorized yet)

## Confirmed on 2026-10-21
- ThinkCentre browser backup contains 32 sales (53 line items), one open shift and 265 products.
- Rehearsal imported all sales and the shift into a **temporary copy** of the live SQLite DB.
- All 265 product IDs, stock quantities and batch JSON were identical before/after.
- Live server database initially had no sales; browser-only sales are not protected by SQLite backups.
- Test owner sync worked across Mac/Android for stock, checkout, expenses and edit conflicts.

## Before deployment
1. Obtain **explicit owner approval**. No live changes until then.
2. Confirm ThinkCentre browser backup is current: new live sales since the export require a new backup and another rehearsal.
3. Verify the backup has not been committed to GitHub or exposed through any web-served directory. Keep a separate protected copy.
4. Ensure a verified SQLite backup of the **current** live database (use SQLite backup API; WAL files mean a raw DB copy is not sufficient).
5. Back up the actual live frontend at `public/index.html` and deployment configuration. Test frontend lives at repository root `index.html`; copying files blindly will NOT update the served page.
6. Rehearse a complete deployment on an isolated instance with the migrated database and the correct frontend route. Verify auth, products, stock, batches, sales list, receipt numbering (next receipt should be 33 if no newer sales), and shift history.
7. Verify sales/shift import is **idempotent**, including handling existing records, and preserves inventory. Do not deduct inventory again for historical sales.
8. Review legacy-browser localStorage behavior on first upgraded login: never overwrite the imported history with stale local sales, and never discard local data.
9. Test actual post-upgrade owner Mac/Android auto-sync and checkout on the isolated instance.
10. Prepare a tested rollback of app files + SQLite database and a plan for any transactions recorded after cutover.

## Known gaps / stop conditions
- The current `scripts/rehearse-browser-sales.js` is **rehearsal-only**: it creates a temporary database and does not implement a production import or rollback.
- The shift's raw browser metadata is preserved in `shifts.metadata_json`, but the owner UI does not yet have a verified server-backed shift-history view.
- Do not assume the initial 32-sale export is still current when deployment happens.
- Production checkout must not start at receipt #1 after migration.
- Live server and test server use different frontend paths. Deployment must explicitly account for this.
- No deploy until all gates above are satisfied and owner approves.
