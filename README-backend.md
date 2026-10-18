# Shop POS backend

This branch adds an Express + SQLite backend to the existing static POS repository. It keeps the existing root-level `index.html` and serves only the known frontend files; it does not expose the repository directory as a public static folder.

## Requirements
- Node.js 20 or newer
- npm

## Run locally
```sh
npm install
npm start
```
Open http://localhost:3000. The database is created at `data/shop-pos.db` by default. Set `DATABASE_PATH` to choose another location; set `PORT` to change the port.

## API endpoints
- `GET /api/health` — process health check
- `GET /api/status` — database tables
- `GET /api/products` — list products (owner login required)
- `POST /api/products` — create/update a product (owner login required)
- `DELETE /api/products/:id` — delete a product (owner login required)
- `/api/auth/*` — owner setup/login/session endpoints
- `POST /api/migrate` — import a POS backup JSON (owner login required)

Prices and money values are stored as integer cents in SQLite. `data/` and SQLite database files are intentionally ignored by Git. Never commit live POS data, passwords, session tokens, or `.env` files.

## Important before deployment
- The owner setup endpoint is limited to localhost. Create the owner account on the server computer.
- Use HTTPS and review proxy settings before exposing the service publicly.
- The frontend owner screen now detects this backend and uses the server-side password login. Initial owner setup is permitted only when opening the app on the server computer (for example, `http://localhost:3000`); attempts from another device are rejected by the server.
- Product create/edit/delete now sync to SQLite when an owner is logged in through the backend. On login, the app asks before merging products: server-only products are added locally, local-only products are uploaded, and same-ID products are kept local without silently overwriting the server. Product metadata (categories, supplier prices, and price history) is retained. Failed deletes are queued locally for retry.
- The merge is a first safety measure, not a full conflict-resolution system. Different products sharing a barcode can fail to upload and need manual review. Products edited on a browser without an active server session remain local until the next confirmed merge.
- An isolated backend smoke test is available with `npm test`; the GitHub Actions workflow runs syntax checks and this test on pull requests. It uses a temporary database and does not test your live POS data.
- Sales, expenses, refunds, cashiers, shifts, and other records are still not automatically synced. This is not a production-ready release. Test with a disposable database and a separate browser profile first. Back up the existing POS before migration. Never clear browser storage to troubleshoot sync.
