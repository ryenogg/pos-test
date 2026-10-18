const express = require("express");
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");
const productsRouter = require("./routes/products");
const migrationRouter = require("./routes/migration");
const authRouter = require("./routes/auth");
const expensesRouter = require("./routes/expenses");
const salesRouter = require("./routes/sales");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, "data", "shop-pos.db"));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, barcode TEXT UNIQUE, name TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0, cost INTEGER, stock INTEGER NOT NULL DEFAULT 0,
    batches_json TEXT NOT NULL DEFAULT '[]', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY, receipt_no INTEGER UNIQUE NOT NULL, date TEXT NOT NULL,
    total INTEGER NOT NULL, received INTEGER NOT NULL, change_amount INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL, reference TEXT, pay_note TEXT, shift_id TEXT, cashier_id TEXT,
    cashier_name TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id TEXT NOT NULL, product_id TEXT NOT NULL,
    product_name TEXT NOT NULL, barcode TEXT, price INTEGER NOT NULL, cost INTEGER, quantity INTEGER NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, amount INTEGER NOT NULL,
    description TEXT, spread TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cashiers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY, cashier_id TEXT, cashier_name TEXT NOT NULL, started_at TEXT NOT NULL,
    ended_at TEXT, opening_cash INTEGER NOT NULL DEFAULT 0, closing_cash INTEGER,
    expected_cash INTEGER, difference INTEGER, selfie_path TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY, sale_id TEXT, date TEXT NOT NULL, amount INTEGER NOT NULL,
    reason TEXT, cashier_id TEXT, cashier_name TEXT, created_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS cash_movements (
    id TEXT PRIMARY KEY, shift_id TEXT, type TEXT NOT NULL, amount INTEGER NOT NULL,
    reason TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL, synced_at TEXT NOT NULL,
    UNIQUE(device_id, entity_type, entity_id)
  );
  CREATE TABLE IF NOT EXISTS owner_account (
    id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
  CREATE INDEX IF NOT EXISTS idx_sales_shift_id ON sales(shift_id);
  CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
  CREATE INDEX IF NOT EXISTS idx_shifts_started_at ON shifts(started_at);
  CREATE INDEX IF NOT EXISTS idx_refunds_date ON refunds(date);
  CREATE INDEX IF NOT EXISTS idx_cash_movements_shift_id ON cash_movements(shift_id);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  if (!columns.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}
ensureColumn("sales", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("expenses", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("expenses", "deleted_at", "TEXT");
ensureColumn("products", "price", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("products", "batches_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("products", "updated_at", "TEXT NOT NULL DEFAULT ''");
ensureColumn("products", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("shifts", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("refunds", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");

app.disable("x-powered-by");
app.use(express.json({ limit: "10mb", strict: true }));
const auth = authRouter(db);
app.use("/api/auth", auth);
app.use("/api/products", productsRouter(db, auth.requireOwner));
app.use("/api/expenses", expensesRouter(db, auth.requireOwner));
app.use("/api/sales", salesRouter(db, auth.requireOwner));
app.use("/api/migrate", migrationRouter(db, auth.requireOwner));

// Serve only the known frontend files. Do not expose server.js, routes, data,
// package files, or other backend files through a general root-directory static server.
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
const frontendFiles = {
  "/sw.js": "sw.js",
  "/manifest.webmanifest": "manifest.webmanifest",
  "/icon-192.png": "icon-192.png",
  "/icon-512.png": "icon-512.png"
};
for (const [url, file] of Object.entries(frontendFiles)) {
  app.get(url, (_req, res) => res.sendFile(path.join(__dirname, file)));
}
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "shop-pos-server", time: new Date().toISOString() }));
app.get("/api/status", (_req, res) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  res.json({ ok: true, database: path.basename(dbPath), tables: tables.map((t) => t.name) });
});
app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ ok: false, error: "Invalid JSON body" });
  console.error("Unhandled request error:", err);
  return res.status(500).json({ ok: false, error: "Internal server error" });
});
const server = app.listen(PORT, HOST, () => console.log(`Shop POS listening on http://${HOST}:${PORT}; database: ${dbPath}`));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
