const express = require("express");
module.exports = function productsRouter(db, requireOwner) {
  const router = express.Router();
  const isMoney = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000000;
  const isStock = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1000000000;
  router.get("/", (_req, res) => {
    try {
      const rows = db.prepare("SELECT id, barcode, name, price, cost, stock, batches_json, metadata_json, created_at, updated_at FROM products ORDER BY name COLLATE NOCASE").all();
      res.json({ ok: true, products: rows.map((r) => ({ ...(JSON.parse(r.metadata_json || "{}")), id: r.id, barcode: r.barcode, name: r.name, price: r.price / 100, cost: r.cost == null ? null : r.cost / 100, stock: r.stock, batches: JSON.parse(r.batches_json || "[]"), created_at: r.created_at, updated_at: r.updated_at })) });
    } catch (e) { console.error("GET products failed", e); res.status(500).json({ ok: false, error: "Unable to load products" }); }
  });
  router.post("/", requireOwner, (req, res) => {
    const p = req.body;
    const name = typeof p?.name === "string" ? p.name.trim() : "";
    if (!p || typeof p.id !== "string" || !p.id.trim() || p.id.length > 200 || !name || name.length > 300 ||
        !isMoney(p.price) || (p.cost != null && p.cost !== "" && !isMoney(p.cost)) ||
        (p.stock != null && !isStock(p.stock)) || (p.barcode != null && typeof p.barcode !== "string") ||
        (p.batches != null && !Array.isArray(p.batches)) || (p.metadata != null && (typeof p.metadata !== "object" || Array.isArray(p.metadata)))) {
      return res.status(400).json({ ok: false, error: "Provide a valid product id, name, price, optional cost, non-negative integer stock, barcode, and batches array" });
    }
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO products (id, barcode, name, price, cost, stock, batches_json, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET barcode=excluded.barcode, name=excluded.name, price=excluded.price, cost=excluded.cost, stock=excluded.stock, batches_json=excluded.batches_json, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
        .run(p.id.trim(), p.barcode?.trim() || null, name, Math.round(p.price * 100), p.cost == null || p.cost === "" ? null : Math.round(p.cost * 100), p.stock ?? 0, JSON.stringify(p.batches || []), JSON.stringify(p.metadata || {}), now, now);
      res.json({ ok: true, id: p.id.trim() });
    } catch (e) {
      if (String(e.code || "").startsWith("SQLITE_CONSTRAINT")) return res.status(409).json({ ok: false, error: "Product conflicts with an existing barcode or database constraint" });
      console.error("POST product failed", e); res.status(500).json({ ok: false, error: "Unable to save product" });
    }
  });
  router.delete("/:id", requireOwner, (req, res) => {
    if (!req.params.id || req.params.id.length > 200) return res.status(400).json({ ok: false, error: "Invalid product id" });
    try { const result = db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id); res.json({ ok: true, deleted: result.changes > 0 }); }
    catch (e) { console.error("DELETE product failed", e); res.status(500).json({ ok: false, error: "Unable to delete product" }); }
  });
  return router;
};
