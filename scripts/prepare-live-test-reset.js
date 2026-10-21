'use strict';
// Prepare a replacement TEST database. Never changes the running test DB or live DB.
// Usage: node scripts/prepare-live-test-reset.js LIVE_DB BROWSER_JSON
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const Database=require('better-sqlite3');
async function main(){
 const root=path.resolve(__dirname,'..'),testPath=path.join(root,'data/test-pos.db');
 const livePath=path.resolve(process.argv[2]||''),browser=path.resolve(process.argv[3]||'');
 if(process.argv.length!==4)throw Error('Usage: node scripts/prepare-live-test-reset.js LIVE_DB BROWSER_JSON');
 if(!fs.existsSync(testPath))throw Error('Test database missing');
 const out=execFileSync(process.execPath,[path.join(__dirname,'rehearse-browser-sales.js'),livePath,browser],{encoding:'utf8'});
 process.stdout.write(out);
 const match=out.match(/^Rehearsal copy: (.+)$/m);if(!match)throw Error('Rehearsal path not found');
 const stage=path.join(root,'data','test-pos-live-reset-STAGED.db');
 if(fs.existsSync(stage))throw Error('Staged database already exists; refusing to overwrite');
 const current=new Database(testPath,{readonly:true,fileMustExist:true});
 try{await current.backup(stage);}finally{current.close();}
 let success=false;
 const db=new Database(stage);
 try{
  db.pragma('foreign_keys = ON');
  db.prepare('ATTACH DATABASE ? AS source').run(match[1]);
  const tables=['products','sales','sale_items','expenses','shifts','cashiers','refunds','cash_movements','sync_log'];
  const columns=table=>db.prepare('PRAGMA table_info("'+table+'")').all().map(x=>x.name);
  const sourceColumns=table=>db.prepare('PRAGMA source.table_info("'+table+'")').all().map(x=>x.name);
  const q=x=>'"'+x.replace(/"/g,'""')+'"';
  db.transaction(()=>{
   for(const table of ['sale_items','sales','expenses','refunds','cash_movements','shifts','cashiers','sync_log','products'])db.exec('DELETE FROM '+q(table));
   for(const table of tables){
    const cols=columns(table).filter(x=>sourceColumns(table).includes(x));
    if(!cols.length)throw Error('No shared columns: '+table);
    const list=cols.map(q).join(',');
    db.exec('INSERT INTO main.'+q(table)+' ('+list+') SELECT '+list+' FROM source.'+q(table));
   }
  }).immediate();
  const counts=Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT COUNT(*) n FROM '+q(t)).get().n]));
  if(counts.products!==265||counts.sales!==32||counts.sale_items!==53||counts.shifts!==1||counts.expenses!==0||counts.refunds!==0)throw Error('Unexpected source counts: '+JSON.stringify(counts));
  const compare=db.prepare('SELECT id,stock,batches_json FROM products ORDER BY id').all();
  const original=db.prepare('SELECT id,stock,batches_json FROM source.products ORDER BY id').all();
  if(JSON.stringify(compare)!==JSON.stringify(original))throw Error('Stock/batch mismatch');
  if(db.pragma('integrity_check',{simple:true})!=='ok')throw Error('Staged integrity check failed');
  const auth=db.prepare('SELECT COUNT(*) n FROM owner_account').get().n;
  if(auth!==1)throw Error('Test owner login not preserved');
  console.log('PASS: staged test DB has live products, stock, sales and shift');
  console.log('PASS: existing test transactions cleared; test owner account preserved');
  console.log('PASS: integrity OK; counts: '+JSON.stringify(counts));
  console.log('STAGED ONLY (not active): '+stage);
  success=true;
 }finally{try{db.close();}catch{} if(!success&&fs.existsSync(stage))fs.unlinkSync(stage);}
}
main().catch(e=>{console.error('PREPARATION FAILED:',e.message);process.exitCode=1});
