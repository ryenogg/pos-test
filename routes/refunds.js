const express = require("express");

// Additive, owner-only refund archive. This endpoint does not modify inventory;
// stock movement must be handled by a separate transactional checkout workflow.
module.exports = function refundsRouter(db, requireOwner) {
  const router = express.Router();
  const validId = v => typeof v === "string" && v.length > 0 && v.length <= 200;
  const validMoney = v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000000;

  router.get("/", requireOwner, (_req, res) => {
    try {
      const rows = db.prepare("SELECT metadata_json FROM refunds ORDER BY date,id").all();
      res.json({ ok: true, refunds: rows.map(row => JSON.parse(row.metadata_json)) });
    } catch (e) {
      console.error("List refunds failed", e);
      res.status(500).json({ ok: false, error: "Unable to load refunds" });
    }
  });

  router.post("/", requireOwner, (req, res) => {
    const r = req.body;
    if (!r || !validId(r.id) || !Number.isSafeInteger(r.no) || r.no <= 0 ||
        typeof r.date !== "string" || !Number.isFinite(Date.parse(r.date)) ||
        !Number.isSafeInteger(r.saleNo) || r.saleNo <= 0 ||
        !validMoney(r.amount) || !["cash", "ewallet"].includes(r.method) ||
        !Array.isArray(r.lines) || r.lines.length === 0 || r.lines.length > 500 ||
        !r.lines.every(l => l && typeof l.name === "string" && l.name.length > 0 &&
          validMoney(l.price) && Number.isSafeInteger(l.qty) && l.qty > 0)) {
      return res.status(400).json({ ok: false, error: "Invalid refund record" });
    }
    try {
      const previous = db.prepare("SELECT metadata_json FROM refunds WHERE id=?").get(r.id);
      if (previous) {
        if (JSON.stringify(JSON.parse(previous.metadata_json)) !== JSON.stringify(r))
          return res.status(409).json({ ok: false, error: "Refund ID already exists with different details" });
        return res.json({ ok: true, id: r.id, alreadyExists: true });
      }
      db.prepare("INSERT INTO refunds (id,sale_id,date,amount,reason,cashier_id,cashier_name,created_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(r.id, null, r.date, Math.round(r.amount * 100), r.reason || null,
          r.cashierId || null, r.by || null, new Date().toISOString(), JSON.stringify(r));
      return res.status(201).json({ ok: true, id: r.id, alreadyExists: false });
    } catch (e) {
      console.error("Save refund failed", e);
      return res.status(500).json({ ok: false, error: "Unable to save refund" });
    }
  });
  return router;
};
