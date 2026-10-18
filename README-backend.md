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
- `GET /api/products` — list products
- `POST /api/products` — create/update a product (owner login required)
- `DELETE /api/products/:id` — delete a product (owner login required)
- `/api/auth/*` — owner setup/login/session endpoints
- `POST /api/migrate` — import a POS backup JSON (owner login required)

Prices and money values are stored as integer cents in SQLite. `data/` and SQLite database files are intentionally ignored by Git. Never commit live POS data, passwords, session tokens, or `.env` files.

## Important before deployment
- The owner setup endpoint is limited to localhost. Create the owner account on the server computer.
- Use HTTPS and review proxy settings before exposing the service publicly.
- The current frontend has not yet been wired to the owner login flow. As a result, product writes from the frontend will receive HTTP 401 until that integration is completed. **Do not merge/deploy this backend as a production replacement yet.**
- The frontend still uses localStorage for some records. Verify API wiring and perform a backup before any migration. Do not clear browser storage to troubleshoot sync.
