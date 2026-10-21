'use strict';
// Safe rehearsal: copies a live SQLite database using SQLite backup API,
// applies the test server's additive schema migrations to the COPY,
// then checks integrity and verifies all original records survived.
// Never opens the original live database for writing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const livePath = path.resolve(process.argv[2] || path.join(os.homedir(), 'shop-pos-server/data/shop-pos.db'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-deployment-rehearsal-'));
const copyPath = path.join(workDir, 'rehearsal.db');
const tables = ['products', 'sales', 'sale_items', 'expenses', 'refunds', 'cashiers', 'shifts', 'cash_movements', 'owner_account', 'auth_sessions', 'sync_log'];
const required = {
  products: ['metadata_json'],
  sales: ['metadata_json'],
  expenses: ['metadata_json', 'deleted_at']
};
function counts(db) {
  const result = {};
  for (const table of tables) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (exists) result[table] = db.prepare('SELECT COUNT(*) AS n FROM "' + table + '"').get().n;
  }
  return result;
}
async function main() {
  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  let original;
  try {
    if (live.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Live source integrity check failed');
    original = counts(live);
    await live.backup(copyPath);
  } finally {
    live.close();
  }
  const copy = new Database(copyPath, { fileMustExist: true });
  try {
    const before = counts(copy);
    if (JSON.stringify(before) !== JSON.stringify(original)) throw new Error('Copy counts differ from source');
    // Same additive migrations as test server startup, but applied ONLY to the temporary copy.
    function ensureColumn(table, column, definition) {
      const columns = copy.pragma('table_info("' + table + '")');
      if (!columns.some(c => c.name === column)) copy.exec('ALTER TABLE "' + table + '" ADD COLUMN "' + column + '" ' + definition);
    }
    copy.transaction(() => {
      ensureColumn('sales', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
      ensureColumn('expenses', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
      ensureColumn('expenses', 'deleted_at', 'TEXT');
      ensureColumn('products', 'price', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn('products', 'batches_json', "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn('products', 'updated_at', "TEXT NOT NULL DEFAULT ''");
      ensureColumn('products', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
      ensureColumn('shifts', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
      ensureColumn('refunds', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
    })();
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Migrated copy integrity check failed');
    const after = counts(copy);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Migration changed record counts');
    for (const [table, columns] of Object.entries(required)) {
      const names = new Set(copy.pragma('table_info("' + table + '")').map(c => c.name));
      for (const col of columns) if (!names.has(col)) throw new Error('Missing ' + table + '.' + col);
    }
    console.log('PASS: original live database was read-only');
    console.log('PASS: migrated temporary copy integrity is ok');
    console.log('PASS: all existing table record counts preserved');
    console.log('PASS: required sync columns exist');
    console.log('Counts:', JSON.stringify(after));
    console.log('Rehearsal copy:', copyPath);
  } finally {
    copy.close();
  }
}
main().catch(error => { console.error('REHEARSAL FAILED:', error.message); process.exitCode = 1; });
