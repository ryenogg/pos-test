const express = require("express");

module.exports = function salesRouter(db, requireOwner) {
  const router = express.Router();
  const money = (n) => Math.round(n * 100);
  const validMoney = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100000000;
  const validId = (v) => typeof v === "string" && v.length > 0 && v.length <= 200;
  const optionalString = (v) => v == null || (typeof v === "string" && v.length <= 2000);
  const validSale = (s) => s && validId(s.id) && Number.isSafeInteger(s.no) && s.no > 0 &&
    typeof s.date === "string" && Number.isFinite(Date.parse(s.date)) &&
    validMoney(s.total) && validMoney(s.received) && validMoney(s.change) &&
    ["cash", "ewallet"].includes(s.method) &&
    ["reference", "payNote", "shiftId", "cashierId", "cashier"].every(k => optionalString(s[k])) &&
    Array.isArray(s.lines) && s.lines.length > 0 && s.lines.length <= 500 &&
    s.lines.every(l => l && validId(String(l.id ?? "")) && typeof l.name === "string" &&
      l.name.length > 0 && l.name.length <= 500 && optionalString(l.barcode) &&
      validMoney(l.price) && (l.cost == null || validMoney(l.cost)) &&
      Number.isSafeInteger(l.qty) && l.qty > 0);

  router.get("/", requireOwner, (_req, res) => {
    try {
      const rows = db.prepare("SELECT metadata_json FROM sales ORDER BY date,id").all();
      res.json({ ok: true, sales: rows.map(r => JSON.parse(r.metadata_json)) });
    } catch (e) {
      console.error("List sales failed", e);
      res.status(500).json({ ok: false, error: "Unable to load sales" });
    }
  });


  // Future online checkout endpoint: allocate receipt number and insert in ONE
  // SQLite transaction. Legacy/manual imports still use POST / and keep their numbers.
  router.post("/assigned", requireOwner, (req, res) => {
    const input = req.body;
    if (!input || input.no != null || !validSale({ ...input, no: 1 }))
      return res.status(400).json({ ok: false, error: "Valid sale without receipt number required" });
    try {
      const insertAssigned = db.transaction(() => {
        const previous = db.prepare("SELECT metadata_json FROM sales WHERE id=?").get(input.id);
        if (previous) {
          const saved = JSON.parse(previous.metadata_json);
          const { no, ...original } = saved;
          if (JSON.stringify(original) !== JSON.stringify(input))
            return { conflict: "Sale ID already exists with different details" };
          return { sale: saved, alreadyExists: true };
        }
        const next = db.prepare("SELECT COALESCE(MAX(receipt_no),0)+1 AS no FROM sales").get().no;
        if (!Number.isSafeInteger(next)) return { conflict: "Receipt number limit reached" };
        const sale = { ...input, no: next };
        db.prepare(`INSERT INTO sales (id,receipt_no,date,total,received,change_amount,method,reference,pay_note,shift_id,cashier_id,cashier_name,created_at,metadata_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          sale.id, sale.no, sale.date, money(sale.total), money(sale.received), money(sale.change), sale.method,
          sale.reference || null, sale.payNote || null, sale.shiftId || null, sale.cashierId || null,
          sale.cashier || null, new Date().toISOString(), JSON.stringify(sale));
        const line = db.prepare("INSERT INTO sale_items (sale_id,product_id,product_name,barcode,price,cost,quantity) VALUES (?,?,?,?,?,?,?)");
        for (const l of sale.lines) line.run(sale.id, String(l.id), l.name, l.barcode || null, money(l.price),
          l.cost == null ? null : money(l.cost), l.qty);
        return { sale, alreadyExists: false };
      });
      const result = insertAssigned.immediate();
      if (result.conflict) return res.status(409).json({ ok: false, error: result.conflict });
      res.status(result.alreadyExists ? 200 : 201).json({ ok: true, ...result });
    } catch (e) {
      console.error("Assigned sale failed", e);
      res.status(500).json({ ok: false, error: "Unable to save assigned sale" });
    }
  });

  router.post("/", requireOwner, (req, res) => {
    const s = req.body;
    if (!validSale(s)) return res.status(400).json({ ok: false, error: "Invalid sale; permanent ID, receipt number, payment and lines are required" });
    try {
      const previous = db.prepare("SELECT metadata_json FROM sales WHERE id=?").get(s.id);
      if (previous) {
        if (JSON.stringify(JSON.parse(previous.metadata_json)) !== JSON.stringify(s))
          return res.status(409).json({ ok: false, error: "Sale ID already exists with different details" });
        return res.json({ ok: true, id: s.id, alreadyExists: true });
      }
      const receipt = db.prepare("SELECT id FROM sales WHERE receipt_no=?").get(s.no);
      if (receipt) return res.status(409).json({ ok: false, error: "Receipt number already belongs to another sale; nothing was overwritten" });
      const save = db.transaction(() => {
        db.prepare(`INSERT INTO sales (id,receipt_no,date,total,received,change_amount,method,reference,pay_note,shift_id,cashier_id,cashier_name,created_at,metadata_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          s.id, s.no, s.date, money(s.total), money(s.received), money(s.change), s.method,
          s.reference || null, s.payNote || null, s.shiftId || null, s.cashierId || null,
          s.cashier || null, new Date().toISOString(), JSON.stringify(s));
        const line = db.prepare("INSERT INTO sale_items (sale_id,product_id,product_name,barcode,price,cost,quantity) VALUES (?,?,?,?,?,?,?)");
        for (const l of s.lines) line.run(s.id, String(l.id), l.name, l.barcode || null, money(l.price),
          l.cost == null ? null : money(l.cost), l.qty);
      });
      save();
      res.status(201).json({ ok: true, id: s.id, alreadyExists: false });
    } catch (e) {
      if (String(e.code || "").startsWith("SQLITE_CONSTRAINT"))
        return res.status(409).json({ ok: false, error: "Sale conflicts with an existing record" });
      console.error("Save sale failed", e);
      res.status(500).json({ ok: false, error: "Unable to save sale" });
    }
  });
  return router;
};
