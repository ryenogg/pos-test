# Shop POS backend

This branch adds the Express + SQLite backend source to the existing static POS repository. It does not replace `index.html` or claim the current browser UI is already connected to every API.

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
- `POST /api/products` — create/update a product (JSON)
- `DELETE /api/products/:id` — delete a product
- `/api/auth/*` — owner setup/login/session endpoints
- `POST /api/migrate` — import a POS backup JSON with `items`, `sales`, `expenses`, `shifts`, `cashiers`, and `refunds` arrays

Prices and money values are stored as integer cents in SQLite. `data/` and SQLite database files are intentionally ignored by Git. Never commit live POS data, passwords, session tokens, or `.env` files.

## Important deployment note
The owner setup endpoint is intentionally limited to localhost. Do not expose the service directly to the public internet without HTTPS, operational backups, and a deployment-specific security review. The existing frontend may still use localStorage for some records; verify API wiring before relying on the database as the sole source of truth.
