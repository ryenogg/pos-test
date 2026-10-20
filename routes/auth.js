const express = require("express");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const COOKIE = "shop_pos_session";
const SESSION_HOURS = 12;
module.exports = function authRouter(db) {
  const router = express.Router();
  const account = () => db.prepare("SELECT id FROM owner_account WHERE id=1").get();
  const local = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "");
  const digest = (t) => crypto.createHash("sha256").update(t).digest("hex");
  const readCookie = (req) => (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) || "";
  const cookieOptions = (req, maxAge) => ({ httpOnly: true, sameSite: "strict", secure: req.secure || req.headers["x-forwarded-proto"] === "https", path: "/", ...(maxAge ? { maxAge } : {}) });
  const hashPassword = async (p, salt) => (await scrypt(p, salt, 64)).toString("hex");
  async function requireOwner(req, res, next) {
    try {
      const token = readCookie(req);
      const session = token && db.prepare("SELECT token_hash FROM auth_sessions WHERE token_hash=? AND expires_at>?").get(digest(token), Date.now());
      if (!session || !account()) return res.status(401).json({ ok: false, error: "Please log in" });
      next();
    } catch (e) { console.error("Auth check failed", e); res.status(500).json({ ok: false, error: "Authentication check failed" }); }
  }
  router.get("/status", (_req, res) => res.json({ ok: true, configured: !!account() }));
  router.post("/setup", async (req, res) => {
    if (!local(req)) return res.status(403).json({ ok: false, error: "Initial owner setup must be done on the server computer" });
    if (account()) return res.status(409).json({ ok: false, error: "Owner account already exists" });
    const password = req.body?.password;
    if (typeof password !== "string" || password.length < 8 || password.length > 200) return res.status(400).json({ ok: false, error: "Password must be 8 to 200 characters" });
    try {
      const salt = crypto.randomBytes(16).toString("hex");
      db.prepare("INSERT INTO owner_account (id,salt,password_hash,created_at) VALUES (1,?,?,?)").run(salt, await hashPassword(password, salt), new Date().toISOString());
      res.json({ ok: true });
    } catch (e) { console.error("Owner setup failed", e); res.status(500).json({ ok: false, error: "Owner setup failed" }); }
  });
  const failures = new Map();
  router.post("/login", async (req, res) => {
    const ip = req.socket.remoteAddress || "unknown"; const now = Date.now();
    const record = failures.get(ip) || { count: 0, until: 0 };
    if (record.until > now) return res.status(429).json({ ok: false, error: "Too many attempts. Please wait before trying again." });
    const password = req.body?.password;
    const owner = db.prepare("SELECT salt,password_hash FROM owner_account WHERE id=1").get();
    if (!owner || typeof password !== "string" || password.length > 200) return res.status(401).json({ ok: false, error: "Invalid password" });
    try {
      const actual = Buffer.from(await hashPassword(password, owner.salt), "hex"); const expected = Buffer.from(owner.password_hash, "hex");
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        record.count++; if (record.count >= 5) { record.count = 0; record.until = now + 30000; } failures.set(ip, record);
        return res.status(401).json({ ok: false, error: "Invalid password" });
      }
      failures.delete(ip); const token = crypto.randomBytes(32).toString("hex"); const expiresAt = now + SESSION_HOURS * 3600000;
      db.prepare("INSERT INTO auth_sessions (token_hash,expires_at,created_at) VALUES (?,?,?)").run(digest(token), expiresAt, new Date().toISOString());
      res.cookie(COOKIE, token, cookieOptions(req, SESSION_HOURS * 3600000)); res.json({ ok: true, expiresAt });
    } catch (e) { console.error("Login failed", e); res.status(500).json({ ok: false, error: "Login failed" }); }
  });
  router.get("/me", requireOwner, (_req, res) => res.json({ ok: true, role: "owner" }));
  router.post("/logout", (req, res) => { const token = readCookie(req); if (token) db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(digest(token)); res.clearCookie(COOKIE, cookieOptions(req)); res.json({ ok: true }); });
  router.requireOwner = requireOwner;
  return router;
};
