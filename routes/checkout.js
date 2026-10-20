const express = require("express");

// Server-authoritative checkout. A single SQLite transaction validates stock,
// allocates a receipt number, deducts inventory and records the sale.
module.exports = function checkoutRouter(db, requireOwner) {
  const router = express.Router();
  const validMoney = n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100000000;
  const cents = n => Math.round(n * 100);
  router.post("/", requireOwner, (req, res) => {
    const s = req.body;
    if (!s || typeof s.id !== "string" || !s.id || s.id.length > 200 ||
        !["cash", "ewallet"].includes(s.method) || !validMoney(s.received) ||
        !Array.isArray(s.lines) || !s.lines.length || s.lines.length > 500 ||
        !s.lines.every(l => l && typeof l.id === "string" && l.id.length > 0 && l.id.length <= 200 &&
          Number.isSafeInteger(l.qty) && l.qty > 0 && (!l.custom ||
          (typeof l.name === "string" && l.name.trim().length > 0 && validMoney(l.price))))) {
      return res.status(400).json({ ok: false, error: "Invalid checkout" });
    }
    try {
      const transact = db.transaction(() => {
        const old = db.prepare("SELECT metadata_json FROM sales WHERE id=?").get(s.id);
        if (old) return { sale: JSON.parse(old.metadata_json), alreadyExists: true };
        const lines = [];
        const updates = new Map();
        for (const line of s.lines) {
          if (line.custom) {
            lines.push({ id: line.id, custom: true, name: line.name.trim(), barcode: null,
              price: line.price, cost: null, qty: line.qty, expiry: null, taken: [] });
            continue;
          }
          const row = db.prepare("SELECT * FROM products WHERE id=?").get(line.id);
          if (!row) return { conflict: "Product is missing: " + line.id };
          const current = updates.get(line.id) || { stock: row.stock, batches: JSON.parse(row.batches_json || "[]") };
          if (current.stock < line.qty) return { conflict: "Insufficient stock: " + row.name };
          const taken = [];
          let remaining = line.qty;
          for (const batch of current.batches) {
            if (remaining <= 0) break;
            const available = Math.max(0, Math.floor(Number(batch.qty) || 0));
            const qty = Math.min(available, remaining);
            if (qty) {
              taken.push({ ...batch, qty });
              batch.qty = available - qty;
              remaining -= qty;
            }
          }
          // Legacy products may have stock without batch allocations.
          if (remaining && current.batches.length) return { conflict: "Batch stock mismatch: " + row.name };
          current.stock -= line.qty;
          updates.set(line.id, current);
          const unitCost = taken.length === line.qty && taken.every(b => validMoney(b.cost))
            ? taken.reduce((sum, b) => sum + b.cost * b.qty, 0) / line.qty : row.cost == null ? null : row.cost / 100;
          lines.push({ id: row.id, name: row.name, barcode: row.barcode, price: row.price / 100,
            cost: unitCost, qty: line.qty, expiry: null, taken });
        }
        const total = Math.round(lines.reduce((sum, l) => sum + cents(l.price) * l.qty, 0)) / 100;
        if (cents(s.received) < cents(total)) return { conflict: "Payment is below total" };
        const no = db.prepare("SELECT COALESCE(MAX(receipt_no),0)+1 AS no FROM sales").get().no;
        const sale = { id: s.id, no, date: new Date().toISOString(), lines, total,
          received: s.received, change: Math.round((s.received - total) * 100) / 100,
          method: s.method, reference: s.reference || "", payNote: s.payNote || "",
          shiftId: null, cashierId: null, cashier: "Owner" };
        for (const [id, update] of updates) {
          db.prepare("UPDATE products SET stock=?, batches_json=?, updated_at=? WHERE id=?")
            .run(update.stock, JSON.stringify(update.batches), sale.date, id);
        }
        db.prepare(`INSERT INTO sales (id,receipt_no,date,total,received,change_amount,method,reference,pay_note,shift_id,cashier_id,cashier_name,created_at,metadata_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sale.id, no, sale.date, cents(total),
          cents(s.received), cents(sale.change), sale.method, sale.reference, sale.payNote,
          null, null, sale.cashier, sale.date, JSON.stringify(sale));
        const insertLine = db.prepare("INSERT INTO sale_items (sale_id,product_id,product_name,barcode,price,cost,quantity) VALUES (?,?,?,?,?,?,?)");
        for (const l of lines) insertLine.run(sale.id, l.id, l.name, l.barcode,
          cents(l.price), l.cost == null ? null : cents(l.cost), l.qty);
        return { sale, alreadyExists: false };
      });
      const result = transact.immediate();
      if (result.conflict) return res.status(409).json({ ok: false, error: result.conflict });
      return res.status(result.alreadyExists ? 200 : 201).json({ ok: true, ...result });
    } catch (e) {
      console.error("Atomic checkout failed", e);
      return res.status(500).json({ ok: false, error: "Checkout could not be saved" });
    }
  });
  return router;
};
