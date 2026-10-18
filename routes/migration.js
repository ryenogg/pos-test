const express = require("express");
module.exports = function migrationRouter(db, requireOwner) {
  const router = express.Router();
  const money = (v) => typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : 0;
  const str = (v, fallback = null) => v == null || v === "" ? fallback : String(v);
  router.post("/", requireOwner, (req, res) => {
    const data = req.body;
    const keys = ["items", "sales", "expenses", "shifts", "cashiers", "refunds"];
    if (!data || typeof data !== "object" || keys.some((k) => !Array.isArray(data[k]))) {
      return res.status(400).json({ ok: false, error: "Invalid POS backup format; expected items, sales, expenses, shifts, cashiers, and refunds arrays" });
    }
    const now = new Date().toISOString();
    try {
      const migrate = db.transaction(() => {
        const cashier = db.prepare("INSERT INTO cashiers (id,name,pin_hash,active,created_at) VALUES (?,?,NULL,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name");
        for (const c of data.cashiers) if (c && c.id && typeof c.name === "string" && c.name.trim()) cashier.run(String(c.id), c.name.trim(), now);
        const product = db.prepare(`INSERT INTO products (id,barcode,name,price,cost,stock,batches_json,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET barcode=excluded.barcode,name=excluded.name,price=excluded.price,cost=excluded.cost,stock=excluded.stock,batches_json=excluded.batches_json,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`);
        for (const p of data.items) {
          if (!p || !p.id || typeof p.name !== "string" || !p.name.trim()) continue;
          if (p.price != null && (typeof p.price !== "number" || !Number.isFinite(p.price) || p.price < 0)) throw new Error("Product has invalid price");
          if (p.stock != null && (typeof p.stock !== "number" || !Number.isFinite(p.stock) || p.stock < 0)) throw new Error("Product has invalid stock");
          product.run(String(p.id), str(p.barcode), p.name.trim(), money(p.price), typeof p.cost === "number" ? money(p.cost) : null, Number.isFinite(p.stock) ? Math.floor(p.stock) : 0, JSON.stringify(Array.isArray(p.batches) ? p.batches : []), JSON.stringify(p), now, now);
        }
        const expense = db.prepare(`INSERT INTO expenses (id,date,amount,description,spread,created_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET date=excluded.date,amount=excluded.amount,description=excluded.description,spread=excluded.spread`);
        for (const e of data.expenses) if (e && e.id) expense.run(String(e.id), str(e.date, now), money(e.amount), str(e.description, ""), str(e.spread), now);
        const shift = db.prepare(`INSERT INTO shifts (id,cashier_id,cashier_name,started_at,ended_at,opening_cash,closing_cash,expected_cash,difference,selfie_path,metadata_json)
          VALUES (?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET cashier_id=excluded.cashier_id,cashier_name=excluded.cashier_name,started_at=excluded.started_at,ended_at=excluded.ended_at,opening_cash=excluded.opening_cash,closing_cash=excluded.closing_cash,expected_cash=excluded.expected_cash,difference=excluded.difference,metadata_json=excluded.metadata_json`);
        for (const s of data.shifts) if (s && s.id) {
          const metadata = { ...s }; delete metadata.selfie;
          shift.run(String(s.id), str(s.cashierId), str(s.cashier || s.cashierName, "Unknown"), str(s.openedAt || s.startedAt || s.start, now), str(s.closedAt || s.endedAt || s.end), money(s.float ?? s.openingCash), typeof s.actual === "number" ? money(s.actual) : (typeof s.closingCash === "number" ? money(s.closingCash) : null), typeof s.expected === "number" ? money(s.expected) : (typeof s.expectedCash === "number" ? money(s.expectedCash) : null), typeof s.difference === "number" ? money(s.difference) : null, JSON.stringify(metadata));
        }
        const sale = db.prepare(`INSERT INTO sales (id,receipt_no,date,total,received,change_amount,method,reference,pay_note,shift_id,cashier_id,cashier_name,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET receipt_no=excluded.receipt_no,date=excluded.date,total=excluded.total,received=excluded.received,change_amount=excluded.change_amount,method=excluded.method,reference=excluded.reference,pay_note=excluded.pay_note,shift_id=excluded.shift_id,cashier_id=excluded.cashier_id,cashier_name=excluded.cashier_name`);
        const clearLines = db.prepare("DELETE FROM sale_items WHERE sale_id=?");
        const line = db.prepare("INSERT INTO sale_items (sale_id,product_id,product_name,barcode,price,cost,quantity) VALUES (?,?,?,?,?,?,?)");
        for (const s of data.sales) {
          if (!s || !Array.isArray(s.lines) || !Number.isFinite(Number(s.no))) throw new Error("A sale is missing a valid receipt number or lines");
          const id = String(s.id || "legacy-sale-" + s.no);
          sale.run(id, Number(s.no), str(s.date, now), money(s.total), money(s.received), money(s.change), str(s.method, "cash"), str(s.reference), str(s.payNote), str(s.shiftId), str(s.cashierId), str(s.cashier), now);
          clearLines.run(id);
          for (const l of s.lines) {
            if (!l) continue;
            if (l.qty != null && (!Number.isFinite(Number(l.qty)) || Number(l.qty) < 0)) throw new Error("Sale line has invalid quantity");
            line.run(id, str(l.id, ""), str(l.name, ""), str(l.barcode), money(l.price), typeof l.cost === "number" ? money(l.cost) : null, Math.floor(Number(l.qty || 0)));
          }
        }
        const refund = db.prepare(`INSERT INTO refunds (id,sale_id,date,amount,reason,cashier_id,cashier_name,created_at,metadata_json)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sale_id=excluded.sale_id,date=excluded.date,amount=excluded.amount,reason=excluded.reason,cashier_id=excluded.cashier_id,cashier_name=excluded.cashier_name,metadata_json=excluded.metadata_json`);
        for (const r of data.refunds) if (r && r.id) refund.run(String(r.id), str(r.saleId || r.saleNo), str(r.date, now), money(r.amount), str(r.reason), str(r.cashierId), str(r.cashier || r.by), now, JSON.stringify(r));
      });
      migrate();
      res.json({ ok: true, message: "POS backup migrated successfully", counts: Object.fromEntries(keys.map((k) => [k, data[k].length])) });
    } catch (e) {
      console.error("Migration failed:", e);
      const constraint = String(e.code || "").startsWith("SQLITE_CONSTRAINT");
      res.status(constraint ? 409 : 400).json({ ok: false, error: constraint ? "Backup conflicts with existing database constraints" : "Migration failed; transaction rolled back", detail: e.message });
    }
  });
  return router;
};
