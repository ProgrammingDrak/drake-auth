const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");
const { createDevicePairing, createPgDevicePairingStore } = require("./device-pairing.cjs");

const databaseUrl = process.env.AUTH_PAIRING_TEST_DATABASE_URL;
async function fixture(t) {
  const { Pool } = require("pg");
  assert(["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname), "Test database must be localhost");
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = "pairing_" + crypto.randomBytes(8).toString("hex");
  await admin.query('CREATE SCHEMA "' + schema + '"');
  const pool = new Pool({ connectionString: databaseUrl, options: "-c search_path=" + schema, max: 1 });
  await pool.query("CREATE TABLE sessions (sid VARCHAR PRIMARY KEY, sess JSON NOT NULL, expire TIMESTAMP NOT NULL)");
  const PgSession = require("connect-pg-simple")(session);
  const store = createPgDevicePairingStore(pool);
  const accounts = new Map([["1", { userId: 1, username: "one", label: "one@example.test", workspaceId: "ws-1" }],
    ["2", { userId: 2, username: "two", label: "two@example.test", workspaceId: "ws-2" }]]);
  let failSave = false;
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "synthetic-local-session-secret-at-least-32-characters", resave: false, saveUninitialized: false,
    store: new PgSession({ pool, schemaName: schema, tableName: "sessions", pruneSessionInterval: false }) }));
  app.post("/test/login", (req, res) => {
    req.session.userId = req.body.userId;
    res.json({ ok: true });
  });
  app.get("/test/me", (req, res) => res.json({ userId: req.session.userId, workspaceId: req.session.workspaceId }));
  const adapters = {
    store, secret: "synthetic-pairing-secret-at-least-32-characters",
    getAccount: req => accounts.get(String(req.session.userId)),
    resolveAccount: id => accounts.get(String(id)),
    onSession: (req, account) => {
      Object.assign(req.session, account);
      if (failSave) req.session.save = callback => callback(new Error("synthetic session save failure"));
    }
  };
  app.use(createDevicePairing(adapters).router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  function agent() {
    let cookie = "";
    return {
      async post(action, body = {}, headers = {}) {
        const response = await fetch(origin + "/api/auth/device/" + action, {
          method: "POST",
          headers: { origin, "content-type": "application/json", "x-device-pairing": "1", cookie, ...headers },
          body: JSON.stringify(body)
        });
        if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
        return { status: response.status, body: await response.json() };
      },
      async login(userId) {
        const response = await fetch(origin + "/test/login", { method: "POST",
          headers: { "content-type": "application/json", cookie }, body: JSON.stringify({userId}) });
        if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
      },
      async me() { return (await fetch(origin + "/test/me", {headers:{cookie}})).json(); },
      cookie: () => cookie
    };
  }
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
  });
  return { store, pool, accounts, agent, failSave: value => { failSave = value; } };
}

test("phone pairing requires a strong server secret and account adapters", () => {
  assert.throws(() => createDevicePairing({ secret: "short" }), /32-character/);
  assert.throws(() => createDevicePairing({ secret: "s".repeat(32) }), /adapters/);
});

test("real PostgreSQL binds codes to glasses, account, explicit confirmation and one redemption",
  { skip: !databaseUrl }, async t => {
  const { agent, pool } = await fixture(t);
  const glasses = agent(), stranger = agent(), phone = agent();
  assert.equal((await glasses.post("start", {}, {"x-device-pairing": ""})).status, 403);
  assert.equal((await glasses.post("start", {}, {origin: "https://evil.test"})).status, 403);
  assert.equal((await glasses.post("start", {}, {"sec-fetch-site": "cross-site"})).status, 403);
  const started = await glasses.post("start");
  assert.equal(started.status, 200);
  assert.match(started.body.code, /^\d{6}$/);
  const oldCookie = glasses.cookie();
  assert.deepEqual((await glasses.post("start")).body, started.body);
  assert.equal((await stranger.post("status")).body.state, "expired");
  assert.equal((await stranger.post("redeem")).status, 401);
  assert.equal((await glasses.post("redeem")).status, 409);
  assert.equal((await phone.post("inspect", {code:started.body.code})).status, 401);
  await phone.login(1);
  assert.equal((await phone.post("inspect", {code:"abcdef"})).status, 400);
  const inspected = await phone.post("inspect", {code:started.body.code});
  assert.equal(inspected.body.account, "one@example.test");
  assert.equal((await glasses.post("status")).body.state, "waiting");
  assert.equal((await phone.post("approve", {challenge:"wrong"})).status, 409);
  assert.equal((await phone.post("approve", {challenge:inspected.body.challenge})).status, 200);
  assert.equal((await stranger.post("redeem")).status, 401);
  const approvedCookie = glasses.cookie();
  assert.equal((await glasses.post("status")).body.state, "approved");
  const responses = await Promise.all([glasses.post("redeem"), glasses.post("redeem")]);
  assert.equal(responses.filter(response=>response.status===200).length,1);
  assert(responses.every(response=>[200,401,410].includes(response.status)));
  assert.notEqual(glasses.cookie(), oldCookie);
  assert.equal((await glasses.me()).userId, 1);
  assert.equal((await glasses.me()).workspaceId, "ws-1");
  assert.equal((await phone.me()).userId, 1);
  // Replaying the old cookie cannot create a second authenticated session.
  assert.equal((await stranger.post("redeem", {}, {cookie:approvedCookie})).status, 401);
  const { rows } = await pool.query("SELECT * FROM auth_device_pairings");
  assert.equal(rows.length, 1);
  assert(rows[0].redeemed_at);
  assert(!JSON.stringify(rows).includes(started.body.code));
});

test("account changes, deleted accounts, cancellation, expiry and session-save failures stay recoverable",
  { skip: !databaseUrl }, async t => {
  const { agent, pool, accounts, failSave } = await fixture(t);
  const phone = agent(), glasses = agent();
  await phone.login(1);
  const started = await glasses.post("start");
  const inspected = await phone.post("inspect", {code:started.body.code});
  await phone.login(2);
  assert.equal((await phone.post("approve", {challenge:inspected.body.challenge})).status, 409);
  await phone.login(1);
  const fresh = await phone.post("inspect", {code:started.body.code});
  assert.equal((await phone.post("approve", {challenge:fresh.body.challenge})).status, 200);
  accounts.delete("1");
  assert.equal((await glasses.post("redeem")).status, 401);
  accounts.set("1", {userId:1,label:"one",workspaceId:"ws-1"});
  const retry = await glasses.post("start");
  const retryApproval = await phone.post("inspect", {code:retry.body.code});
  await phone.post("approve", {challenge:retryApproval.body.challenge});
  failSave(true);
  assert.equal((await glasses.post("redeem")).status, 503);
  const { rows } = await pool.query("SELECT redeemed_at FROM auth_device_pairings");
  assert(rows.every(row => row.redeemed_at === null));
  assert.equal((await glasses.me()).userId, undefined);

  const cancelled = agent();
  const cancelledCode = await cancelled.post("start");
  assert.equal((await cancelled.post("cancel")).status, 200);
  assert.equal((await phone.post("inspect", {code:cancelledCode.body.code})).status, 400);
  const expired = agent();
  const expiredCode = await expired.post("start");
  await pool.query("UPDATE auth_device_pairings SET expires_at=NOW()-INTERVAL '1 minute'");
  assert.equal((await expired.post("status")).body.state, "expired");
  assert.equal((await phone.post("inspect", {code:expiredCode.body.code})).status, 400);
  const renewed = await expired.post("start");
  assert.equal(renewed.status, 200);
  assert.notEqual(renewed.body.code, expiredCode.body.code);
});

test("PostgreSQL throttling is shared across stores and rolls back failed transactions",
  { skip: !databaseUrl }, async t => {
  const { store, pool } = await fixture(t);
  const other = createPgDevicePairingStore(pool);
  await store.limit("same", 2, 600);
  await other.limit("same", 2, 600);
  await assert.rejects(store.limit("same", 2, 600), error=>error.status===429);
  await assert.rejects(store.transaction(async client=>{
    await client.query("INSERT INTO auth_device_pairing_limits VALUES ('rollback',1,NOW())");
    throw new Error("rollback");
  }), /rollback/);
  assert.equal((await pool.query("SELECT * FROM auth_device_pairing_limits WHERE key='rollback'")).rowCount,0);
  await pool.query("UPDATE auth_device_pairing_limits SET expires_at=NOW()-INTERVAL '1 second'");
  await other.limit("same",2,600);
});
