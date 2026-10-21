'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(root, 'data', 'test-pos.db');
const backupDir = path.join(root, 'backups');
const retention = 14;

async function main() {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDir, `test-pos-${stamp}.db`);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destination);
  } finally {
    source.close();
  }
  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Backup integrity check failed');
    }
  } finally {
    backup.close();
  }
  const backups = fs.readdirSync(backupDir)
    .filter(name => /^test-pos-\d{4}-\d{2}-\d{2}T.*\.db$/.test(name))
    .sort().reverse();
  for (const old of backups.slice(retention)) fs.unlinkSync(path.join(backupDir, old));
  console.log('Verified test POS backup:', destination);
}
main().catch(error => { console.error('Backup failed:', error); process.exitCode = 1; });
