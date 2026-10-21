'use strict';
// Rehearse importing a browser backup into a TEMPORARY SQLite copy.
// Usage: node scripts/rehearse-browser-sales.js /path/to/live.db /path/to/browser-backup.json
// Never writes to the live database or changes inventory stock.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
async function main() {
  const source = path.resolve(process.argv[2] || '');
  const backupFile = path.resolve(process.argv[3] || '');
  if (process.argv.length < 4) throw Error('Usage: node scripts/rehearse-browser-sales.js LIVE_DB BACKUP_JSON');
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  if (!backup || !Array.isArray(backup.sales) || !Array.isArray(backup.items) || !Array.isArray(backup.shifts)) throw Error('Invalid browser backup');
  const nos = new Set(), ids = new Set();
  for (const s of backup.sales) {
    if (!Number.isSafeInteger(s.no) || s.no < 1 || nos.has(s.no)) throw Error('Duplicate/invalid receipt number');
    nos.add(s.no);
    if (!s.date || !Number.isFinite(Date.parse(s.date)) || !Array.isArray(s.lines) || !s.lines.length) throw Error('Invalid sale date or lines');
    if (!['cash','ewallet'].includes(s.method) || !Number.isFinite(s.total) || !Number.isFinite(s.received) || !Number.isFinite(s.change)) throw Error('Invalid payment');
    for (const l of s.lines) if (!l.id || !l.name || !Number.isSafeInteger(l.qty) || l.qty <= 0 || !Number.isFinite(l.price)) throw Error('Invalid sale line');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-browser-sales-rehearsal-'));
  const copyPath = path.join(dir, 'rehearsal.db');
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try { await live.backup(copyPath); } finally { live.close(); }
  const db = new Database(copyPath, { fileMustExist: true });
  try {
    const before = db.prepare('SELECT id,stock,batches_json FROM products ORDER BY id').all();
    const originalSales = db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
    const originalLines = db.prepare('SELECT COUNT(*) AS n FROM sale_items').get().n;
    const originalShifts = db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n;
    const columns = new Set(db.pragma('table_info(sales)').map(c => c.name));
    if (!columns.has('metadata_json')) db.exec("ALTER TABLE sales ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    const cents = n => Math.round(Number(n) * 100);
    const insertSale = db.prepare('INSERT INTO sales (id,receipt_no,date,total,received,change_amount,method,reference,pay_note,shift_id,cashier_id,cashier_name,created_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertLine = db.prepare('INSERT INTO sale_items (sale_id,product_id,product_name,barcode,price,cost,quantity) VALUES (?,?,?,?,?,?,?)');
    const insertShift = db.prepare('INSERT INTO shifts (id,cashier_id,cashier_name,started_at,ended_at,opening_cash,closing_cash,expected_cash,difference,selfie_path,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    let inserted = 0, skipped = 0, lines = 0, shiftsInserted = 0, shiftsSkipped = 0;
    db.transaction(() => {
      for (const sh of backup.shifts) {
        if (!sh || typeof sh.id !== 'string' || !sh.id || !sh.openedAt || !Number.isFinite(Date.parse(sh.openedAt)) || typeof sh.cashier !== 'string' || !Number.isFinite(sh.float) || sh.float < 0 || (sh.closedAt != null && !Number.isFinite(Date.parse(sh.closedAt)))) throw Error('Invalid shift record');
        const existing = db.prepare('SELECT metadata_json FROM shifts WHERE id=?').get(sh.id);
        if (existing) { if (JSON.stringify(JSON.parse(existing.metadata_json)) !== JSON.stringify(sh)) throw Error('Shift ID conflict'); shiftsSkipped++; continue; }
        insertShift.run(sh.id,sh.cashierId||null,sh.cashier,sh.openedAt,sh.closedAt||null,cents(sh.float),null,null,null,null,JSON.stringify(sh));
        shiftsInserted++;
      }
      for (const s of backup.sales) {
        const id = 'browser-sale-' + s.no + '-' + s.date;
        const existing = db.prepare('SELECT id,metadata_json FROM sales WHERE receipt_no=?').get(s.no);
        if (existing) {
          if (JSON.stringify(JSON.parse(existing.metadata_json)) !== JSON.stringify({...s,id:existing.id})) throw Error('Receipt conflict: ' + s.no);
          skipped++; continue;
        }
        const record = {...s,id};
        insertSale.run(id,s.no,s.date,cents(s.total),cents(s.received),cents(s.change),s.method,s.reference||null,s.payNote||null,s.shiftId||null,s.cashierId||null,s.cashier||null,s.date,JSON.stringify(record));
        for (const l of s.lines) { insertLine.run(id,String(l.id),l.name,l.barcode||null,cents(l.price),l.cost==null?null:cents(l.cost),l.qty); lines++; }
        inserted++;
      }
    })();
    const after = db.prepare('SELECT id,stock,batches_json FROM products ORDER BY id').all();
    if (JSON.stringify(before)!==JSON.stringify(after)) throw Error('Product inventory changed');
    if (db.pragma('integrity_check',{simple:true})!=='ok') throw Error('Database integrity check failed');
    if (db.prepare('SELECT COUNT(*) AS n FROM sales').get().n !== originalSales+inserted) throw Error('Sales count mismatch');
    if (db.prepare('SELECT COUNT(*) AS n FROM sale_items').get().n !== originalLines+lines) throw Error('Sale items count mismatch');
    if (db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n !== originalShifts+shiftsInserted) throw Error('Shift count mismatch');
    console.log('PASS: source live database opened read-only and copied');
    console.log('PASS: inventory IDs, stock and batches unchanged ('+before.length+' products)');
    console.log('PASS: imported '+inserted+' sales, '+lines+' lines; '+skipped+' already present');
    console.log('PASS: temporary database integrity ok');
    console.log('PASS: imported '+shiftsInserted+' shift(s); '+shiftsSkipped+' already present');
    console.log('Rehearsal copy:',copyPath);
  } finally { db.close(); }
}
main().catch(e => { console.error('REHEARSAL FAILED:',e.message);process.exitCode=1; });
