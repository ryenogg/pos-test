const express = require("express");

module.exports = function expensesRouter(db, requireOwner) {
  const router = express.Router();
  const money = (n) => Math.round(n * 100);
  const validAmount = (n) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 100000000;
  const validId = (s) => typeof s === "string" && s.length > 0 && s.length <= 200;
  const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

  router.get("/", requireOwner, (_req, res) => {
    try {
      const rows = db.prepare("SELECT id,date,amount,description,spread,metadata_json,deleted_at FROM expenses ORDER BY date,id").all();
      res.json({ ok: true, expenses: rows.map((r) => ({
        ...JSON.parse(r.metadata_json || "{}"), id: r.id, date: r.date,
        amount: r.amount / 100, spread: r.spread, deletedAt: r.deleted_at
      })) });
    } catch (e) {
      console.error("List expenses failed", e);
      res.status(500).json({ ok: false, error: "Unable to load expenses" });
    }
  });

  router.post("/", requireOwner, (req, res) => {
    const e = req.body;
    if (!e || !validId(e.id) || !validDate(e.date) || !validAmount(e.amount) ||
        (e.category != null && (typeof e.category !== "string" || e.category.length > 200)) ||
        (e.note != null && (typeof e.note !== "string" || e.note.length > 2000)) ||
        (e.spread != null && !["month", "once", "day", ""].includes(e.spread))) {
      return res.status(400).json({ ok: false, error: "Invalid expense" });
    }
    try {
      const existing = db.prepare("SELECT metadata_json,deleted_at FROM expenses WHERE id=?").get(e.id);
      if (existing) {
        if (existing.deleted_at) return res.status(409).json({ ok: false, error: "Expense was deleted; ID cannot be reused" });
        const previous = JSON.parse(existing.metadata_json || "{}");
        if (JSON.stringify(previous) !== JSON.stringify(e)) return res.status(409).json({ ok: false, error: "Expense ID already exists with different details" });
        return res.json({ ok: true, id: e.id, alreadyExists: true });
      }
      db.prepare("INSERT INTO expenses (id,date,amount,description,spread,created_at,metadata_json) VALUES (?,?,?,?,?,?,?)")
        .run(e.id, e.date, money(e.amount), e.note || "", e.spread || "", new Date().toISOString(), JSON.stringify(e));
      res.status(201).json({ ok: true, id: e.id, alreadyExists: false });
    } catch (err) {
      console.error("Save expense failed", err);
      res.status(500).json({ ok: false, error: "Unable to save expense" });
    }
  });

  router.delete("/:id", requireOwner, (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ ok: false, error: "Invalid expense ID" });
    try {
      const result = db.prepare("UPDATE expenses SET deleted_at=COALESCE(deleted_at, ?) WHERE id=?")
        .run(new Date().toISOString(), req.params.id);
      res.json({ ok: true, found: result.changes > 0 });
    } catch (e) {
      console.error("Delete expense failed", e);
      res.status(500).json({ ok: false, error: "Unable to delete expense" });
    }
  });
  return router;
};
