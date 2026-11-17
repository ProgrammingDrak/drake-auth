"use strict";

const crypto = require("node:crypto");
const express = require("express");

const TTL_MS = 5 * 60 * 1000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
const fail = (status, message) => Object.assign(new Error(message), { status });
const sessionCall = (req, method) => new Promise((resolve, reject) => {
  req.session[method](error => error ? reject(error) : resolve());
});

/** App-local PostgreSQL storage. Codes never authorize another app's sessions. */
function createPgDevicePairingStore(pool) {
  let ready;
  async function migrate() {
    if (!ready) ready = pool.query(`
      CREATE TABLE IF NOT EXISTS auth_device_pairings (
        device_hash TEXT PRIMARY KEY,
        code_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        approved_user TEXT,
        approved_at TIMESTAMPTZ,
        redeemed_at TIMESTAMPTZ,
        redemption_id TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_device_pairing_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
    `).catch(error => { ready = null; throw error; });
    await ready;
  }
  async function limit(key, maximum, seconds) {
    await migrate();
    const { rows } = await pool.query(`
      INSERT INTO auth_device_pairing_limits AS limits (key, count, expires_at)
      VALUES ($1, 1, NOW() + $2 * INTERVAL '1 second')
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN limits.expires_at <= NOW() THEN 1 ELSE limits.count + 1 END,
        expires_at = CASE WHEN limits.expires_at <= NOW() THEN EXCLUDED.expires_at ELSE limits.expires_at END
      RETURNING count`, [key, seconds]);
    if (rows[0].count > maximum) throw fail(429, "Too many attempts. Wait a few minutes and try again.");
  }
  async function transaction(callback) {
    await migrate();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return { migrate, limit, transaction, query: (...args) => pool.query(...args) };
}

/**
 * Phone authenticates using the app's ordinary sign-in.
 * The code identifies a request. Only its initiating cookie can redeem it.
 */
function createDevicePairing({ store, secret, getAccount, resolveAccount, onSession,
  basePath = "/api/auth/device", origin = null }) {
  if (!secret || secret.length < 32) throw new Error("Device pairing requires a 32-character secret.");
  for (const fn of [getAccount, resolveAccount, onSession]) {
    if (typeof fn !== "function") throw new Error("Device pairing requires account and session adapters.");
  }
  const codeHash = code => crypto.createHmac("sha256", secret).update("device-code:" + code).digest("hex");
  const router = express.Router();
  router.use(basePath, express.json({ limit: "4kb" }), (req, res, next) => {
    res.set("Cache-Control", "no-store");
    // Custom header prevents form-based CSRF even when Origin is absent.
    const expected = origin || req.protocol + "://" + req.get("host");
    if (req.method !== "POST" || req.get("X-Device-Pairing") !== "1" ||
      (req.get("origin") && req.get("origin") !== expected) ||
      (req.get("sec-fetch-site") && req.get("sec-fetch-site") !== "same-origin")) {
      return res.status(403).json({ error: "Open device pairing in this app." });
    }
    if (!req.session) return res.status(503).json({ error: "Sessions are unavailable." });
    next();
  });
  function post(route, callback) {
    router.post(basePath + route, async (req, res) => {
      try { await callback(req, res); }
      catch (error) {
        res.status(error.status || 503).json({
          error: error.status ? error.message : "Pairing is temporarily unavailable. Please try again."
        });
      }
    });
  }
  async function account(req) {
    const found = await getAccount(req);
    if (!found) throw fail(401, "Sign in to this app on your phone first.");
    return found;
  }
  function inputCode(req) {
    const value = req.body?.code;
    if (typeof value !== "string" || value.length > 12) throw fail(400, "Enter the six digits on your glasses.");
    const code = value.replace(/[\s-]/g, "");
    if (!/^\d{6}$/.test(code)) throw fail(400, "Enter the six digits on your glasses.");
    return code;
  }
  async function limited(req, kind) {
    // Both limits survive restarts and are shared by server replicas.
    await store.limit(hash(kind + ":ip:" + req.ip), kind === "start" ? 30 : 20, 600);
    await store.limit(hash(kind + ":session:" + req.sessionID), kind === "start" ? 8 : 12, 600);
  }
  async function pending(req, client = store) {
    if (!req.session.devicePairing) return null;
    const { rows } = await client.query(
      "SELECT *, expires_at <= NOW() AS expired FROM auth_device_pairings WHERE device_hash=$1",
      [hash(req.session.devicePairing.secret)]
    );
    return rows[0] || null;
  }
  post("/start", async (req, res) => {
    if (req.session.userId) return res.json({ state: "connected" });
    await store.migrate();
    const current = await pending(req);
    if (current && !current.expired && !current.redeemed_at) {
      return res.json({ state: current.approved_at ? "approved" : "waiting",
        code: req.session.devicePairing.code, expiresAt: current.expires_at });
    }
    await limited(req, "start");
    await store.query("DELETE FROM auth_device_pairings WHERE expires_at < NOW() - INTERVAL '1 hour'");
    await store.query("DELETE FROM auth_device_pairing_limits WHERE expires_at < NOW()");
    const device = { secret: random(), code: "" };
    for (let attempt = 0; attempt < 5; attempt++) {
      device.code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const { rows } = await store.query(`
        INSERT INTO auth_device_pairings (device_hash, code_hash, expires_at)
        VALUES ($1,$2,NOW()+INTERVAL '5 minutes') ON CONFLICT DO NOTHING RETURNING expires_at`,
      [hash(device.secret), codeHash(device.code)]);
      if (!rows[0]) continue;
      req.session.devicePairing = device;
      delete req.session.deviceApproval;
      await sessionCall(req, "save");
      return res.json({ state: "waiting", code: device.code, expiresAt: rows[0].expires_at });
    }
    throw fail(503, "Could not create a pairing code. Please try again.");
  });
  post("/status", async (req, res) => {
    if (req.session.userId) return res.json({ state: "connected" });
    await store.migrate();
    const current = await pending(req);
    if (!current || current.expired || current.redeemed_at) return res.json({ state: "expired" });
    res.json({ state: current.approved_at ? "approved" : "waiting",
      code: req.session.devicePairing.code, expiresAt: current.expires_at });
  });
  post("/cancel", async (req, res) => {
    await store.migrate();
    if (req.session.devicePairing) await store.query(
      "DELETE FROM auth_device_pairings WHERE device_hash=$1", [hash(req.session.devicePairing.secret)]);
    delete req.session.devicePairing;
    await sessionCall(req, "save");
    res.json({ ok: true });
  });
  post("/inspect", async (req, res) => {
    const user = await account(req);
    await limited(req, "approve");
    const code = inputCode(req);
    const { rows } = await store.query(`
      SELECT device_hash, expires_at FROM auth_device_pairings
      WHERE code_hash=$1 AND expires_at>NOW() AND approved_at IS NULL AND redeemed_at IS NULL`, [codeHash(code)]);
    if (!rows[0]) throw fail(400, "That code is incorrect or expired. Check your glasses.");
    const challenge = random();
    req.session.deviceApproval = { deviceHash: rows[0].device_hash,
      userId: String(user.userId), challenge, expiresAt: Date.now() + TTL_MS };
    await sessionCall(req, "save");
    res.json({ code, challenge, account: user.label, expiresAt: rows[0].expires_at });
  });
  post("/approve", async (req, res) => {
    const user = await account(req);
    await limited(req, "approve");
    const approval = req.session.deviceApproval;
    if (!approval || approval.expiresAt <= Date.now() || approval.userId !== String(user.userId) ||
      req.body?.challenge !== approval.challenge) {
      throw fail(409, "The account or pairing request changed. Enter the code again.");
    }
    const { rows } = await store.query(`
      UPDATE auth_device_pairings SET approved_user=$2,approved_at=NOW()
      WHERE device_hash=$1 AND expires_at>NOW() AND approved_at IS NULL AND redeemed_at IS NULL
      RETURNING device_hash`, [approval.deviceHash, String(user.userId)]);
    if (!rows[0]) throw fail(409, "This request expired or was already approved. Check your glasses.");
    delete req.session.deviceApproval;
    await sessionCall(req, "save");
    res.json({ ok: true });
  });
  post("/redeem", async (req, res) => {
    if (req.session.userId) return res.json({ state: "connected" });
    if (!req.session.devicePairing) throw fail(401, "Start sign-in on these glasses first.");
    await store.migrate();
    const current = await pending(req);
    if (!current || current.expired || current.redeemed_at) throw fail(410, "This code expired. Get a new code.");
    if (!current.approved_at) throw fail(409, "Confirm the connection on your phone first.");
    const deviceHash = hash(req.session.devicePairing.secret);
    const redemptionId = random();
    let reserved = false;
    let regenerated = false;
    try {
      // Regeneration and session-store writes must run outside the row lock.
      // App sessions may use the same bounded PostgreSQL pool as pairing.
      await sessionCall(req, "regenerate");
      regenerated = true;
      await store.transaction(async client => {
        const { rows } = await client.query(`
          SELECT *, expires_at<=NOW() AS expired FROM auth_device_pairings
          WHERE device_hash=$1 FOR UPDATE`, [deviceHash]);
        const row = rows[0];
        if (!row || row.expired || row.redeemed_at) throw fail(410, "This code expired. Get a new code.");
        if (!row.approved_at) throw fail(409, "Confirm the connection on your phone first.");
        const result = await resolveAccount(row.approved_user, client);
        if (!result) throw fail(401, "This account is unavailable. Sign in again.");
        await onSession(req, result, client);
        await client.query("UPDATE auth_device_pairings SET redeemed_at=NOW(),redemption_id=$2 WHERE device_hash=$1",
          [deviceHash, redemptionId]);
      });
      reserved = true;
      await sessionCall(req, "save");
    } catch (error) {
      if (regenerated) await sessionCall(req, "destroy").catch(() => {});
      if (reserved) await store.query(`
        UPDATE auth_device_pairings SET redeemed_at=NULL,redemption_id=NULL
        WHERE device_hash=$1 AND redemption_id=$2`, [deviceHash, redemptionId]).catch(() => {});
      throw error;
    }
    res.json({ state: "connected" });
  });
  return { router };
}

module.exports = { createDevicePairing, createPgDevicePairingStore };
