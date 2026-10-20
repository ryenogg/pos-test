const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

test("backend smoke test: owner auth and product CRUD", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shop-pos-test-"));
  const dbPath = path.join(dir, "test.db");
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATABASE_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode != null) assert.fail("Server exited early: " + logs);
    try { health = await fetch(base + "/api/health"); if (health.ok) break; }
    catch (_) { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(health && health.ok, "server should start and answer health checks: " + logs);

  const unauthorized = await fetch(base + "/api/products", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "test-product", name: "Test", price: 1, stock: 1 })
  });
  assert.equal(unauthorized.status, 401, "product writes require owner login");
  const privateList = await fetch(base + "/api/products");
  assert.equal(privateList.status, 401, "product inventory reads require owner login");

  const setup = await fetch(base + "/api/auth/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-owner-password-123" })
  });
  assert.equal(setup.status, 200, "localhost owner setup should work in the isolated test");
  const login = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-owner-password-123" })
  });
  assert.equal(login.status, 200, "owner login should work");
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie && cookie.includes("shop_pos_session="), "login should set an owner session cookie");

  const product = {
    id: "test-product", barcode: "TEST-001", name: "Test Product", price: 12.5, cost: 7.25, stock: 3,
    batches: [{ date: "2030-01-01", qty: 3, cost: 7.25 }],
    metadata: { categoryId: "test-category", priceHistory: [{ id: "h1", price: 12.5 }], supplierPrices: [] }
  };
  const saved = await fetch(base + "/api/products", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(product)
  });
  assert.equal(saved.status, 200, "authenticated product save should work: " + await saved.clone().text());

  const list = await fetch(base + "/api/products", { headers: { Cookie: cookie } });
  const body = await list.json();
  assert.equal(body.products.length, 1);
  assert.equal(body.products[0].price, 12.5);
  assert.equal(body.products[0].categoryId, "test-category", "product metadata should survive round-trip");
  assert.equal(body.products[0].batches[0].qty, 3);

  const removed = await fetch(base + "/api/products/test-product", {
    method: "DELETE", headers: { Cookie: cookie }
  });
  assert.equal(removed.status, 200, "authenticated product delete should work");
  const after = await (await fetch(base + "/api/products", { headers: { Cookie: cookie } })).json();
  assert.equal(after.products.length, 0);


  const saleHeaders = { "Content-Type": "application/json", Cookie: cookie };
  assert.equal((await fetch(base + "/api/sales")).status, 401, "sales reads require owner login");
  const testSale = {
    id: "test-sale-unique-1", no: 1, date: "2026-10-18T10:00:00.000Z",
    total: 25, received: 30, change: 5, method: "cash",
    lines: [{ id: "test-product", name: "Test Product", barcode: "TEST-001", price: 25, cost: 10, qty: 1 }]
  };
  const saveSale = (payload) => fetch(base + "/api/sales", {
    method: "POST", headers: saleHeaders, body: JSON.stringify(payload)
  });
  assert.equal((await saveSale(testSale)).status, 201, "new sale should save");
  const retriedSale = await saveSale(testSale);
  assert.equal(retriedSale.status, 200, "same sale should be idempotent");
  assert.equal((await retriedSale.json()).alreadyExists, true);
  assert.equal((await saveSale({ ...testSale, total: 26 })).status, 409, "same ID with changed amount must conflict");
  assert.equal((await saveSale({ ...testSale, id: "different-sale" })).status, 409, "same receipt with different ID must conflict");
  assert.equal((await saveSale({ ...testSale, id: "bad-sale", no: 2, lines: [] })).status, 400, "empty sales should be rejected");

  const assignSale = (payload) => fetch(base + "/api/sales/assigned", {
    method: "POST", headers: saleHeaders, body: JSON.stringify(payload)
  });
  const { no: unusedNo, ...unassigned } = testSale;
  const assignedA = { ...unassigned, id: "assigned-sale-a" };
  const assignedB = { ...unassigned, id: "assigned-sale-b" };
  const firstAssigned = await assignSale(assignedA);
  assert.equal(firstAssigned.status, 201, "server should assign a receipt");
  const assignedAResult = await firstAssigned.json();
  assert.equal(assignedAResult.sale.no, 2);
  const secondAssigned = await assignSale(assignedB);
  assert.equal(secondAssigned.status, 201);
  assert.equal((await secondAssigned.json()).sale.no, 3, "separate sales receive unique sequential receipts");
  const assignedRetry = await assignSale(assignedA);
  assert.equal(assignedRetry.status, 200);
  assert.equal((await assignedRetry.json()).sale.no, 2, "retry returns original receipt");
  assert.equal((await assignSale({ ...assignedA, total: 27 })).status, 409, "changed sale cannot reuse ID");
  assert.equal((await assignSale({ ...assignedA, no: 99 })).status, 400, "client cannot assign number on this endpoint");

  const listedSales = await (await fetch(base + "/api/sales", { headers: { Cookie: cookie } })).json();
  assert.equal(listedSales.sales.length, 3);
  assert.deepEqual(listedSales.sales.find(x => x.id === testSale.id), testSale);

  const unauthorizedExpense = await fetch(base + "/api/expenses");
  assert.equal(unauthorizedExpense.status, 401, "expense reads require owner login");
  const testExpense = { id: "expense-test-1", date: "2026-10-18", amount: 18.75, category: "Supplies", note: "Test only", spread: "once" };
  const expenseHeaders = { "Content-Type": "application/json", Cookie: cookie };
  const saveExpense = () => fetch(base + "/api/expenses", { method: "POST", headers: expenseHeaders, body: JSON.stringify(testExpense) });
  assert.equal((await saveExpense()).status, 201, "first expense save should create");
  const retryExpense = await saveExpense();
  assert.equal(retryExpense.status, 200, "retrying the same expense should not duplicate");
  assert.equal((await retryExpense.json()).alreadyExists, true);
  const changedExpense = await fetch(base + "/api/expenses", { method: "POST", headers: expenseHeaders, body: JSON.stringify({ ...testExpense, amount: 19 }) });
  assert.equal(changedExpense.status, 409, "conflicting expense ID should not overwrite");
  const listExpenses = await (await fetch(base + "/api/expenses", { headers: { Cookie: cookie } })).json();
  assert.equal(listExpenses.expenses.length, 1);
  assert.equal(listExpenses.expenses[0].amount, 18.75);
  assert.equal(listExpenses.expenses[0].category, "Supplies");
  // Full-backup migration: preserve relationships and drawer payouts, including retries.
  const backup = {
    items: [{ id: "migration-product", barcode: "MIG-01", name: "Migrated Item", price: 8, stock: 2, batches: [] }],
    sales: [{ no: 50, date: "2026-10-18T11:00:00.000Z", total: 8, received: 8, change: 0,
      method: "cash", shiftId: "migration-shift", lines: [{ id: "migration-product", name: "Migrated Item", price: 8, qty: 1 }] }],
    expenses: [{ id: "migration-expense", date: "2026-10-18", amount: 3, category: "Delivery", note: "Courier", spread: "once" }],
    shifts: [{ id: "migration-shift", cashier: "Owner", openedAt: "2026-10-18T09:00:00.000Z", float: 100,
      payouts: [{ id: "migration-payout", amount: 3, note: "Courier", time: "2026-10-18T12:00:00.000Z" }] }],
    cashiers: [],
    refunds: [{ id: "migration-refund", saleNo: 50, date: "2026-10-18T13:00:00.000Z", amount: 8, reason: "Damaged", by: "Owner" }]
  };
  const migrate = (payload) => fetch(base + "/api/migrate", { method: "POST", headers: saleHeaders, body: JSON.stringify(payload) });
  assert.equal((await migrate(backup)).status, 200, "migration should import complete backup");
  assert.equal((await migrate(backup)).status, 200, "migration retry should be idempotent");
  const migratedSales = await (await fetch(base + "/api/sales", { headers: { Cookie: cookie } })).json();
  assert.equal(migratedSales.sales.find(s => s.no === 50).id, "legacy-sale-50");
  const migratedExpenses = await (await fetch(base + "/api/expenses", { headers: { Cookie: cookie } })).json();
  assert.equal(migratedExpenses.expenses.find(e => e.id === "migration-expense").note, "Courier");
  const sqlite = require("better-sqlite3");
  const checkDb = new sqlite(dbPath, { readonly: true });
  assert.equal(checkDb.prepare("SELECT sale_id FROM refunds WHERE id='migration-refund'").get().sale_id, "legacy-sale-50");
  assert.equal(checkDb.prepare("SELECT COUNT(*) AS n FROM cash_movements WHERE id='migration-payout'").get().n, 1);
  assert.equal(checkDb.prepare("SELECT description FROM expenses WHERE id='migration-expense'").get().description, "Courier");
  checkDb.close();
  const broken = { ...backup, refunds: [{ ...backup.refunds[0], id: "orphan-refund", saleNo: 9999 }] };
  assert.equal((await migrate(broken)).status, 400, "orphan refund must roll back migration");
  const afterRollback = new sqlite(dbPath, { readonly: true });
  assert.equal(afterRollback.prepare("SELECT COUNT(*) AS n FROM refunds WHERE id='orphan-refund'").get().n, 0);
  afterRollback.close();

  const deleteExpense = await fetch(base + "/api/expenses/expense-test-1", { method: "DELETE", headers: { Cookie: cookie } });
  assert.equal(deleteExpense.status, 200);
  const afterDelete = await (await fetch(base + "/api/expenses", { headers: { Cookie: cookie } })).json();
  assert.ok(afterDelete.expenses[0].deletedAt, "deleted expense should have tombstone");
  assert.equal((await saveExpense()).status, 409, "deleted expense must not be resurrected");
});
