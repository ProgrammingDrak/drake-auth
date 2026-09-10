"use strict";

const crypto = require('node:crypto');
const express = require('express');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('base64url');
const random = () => crypto.randomBytes(32).toString('base64url');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const safe = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Persistent, atomic consume is required: two provider processes cannot redeem one code. */
function createPgWorkspaceStore(pool, schema) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid workspace schema.');
  const table = `"${schema}".workspace_credentials`;
  return {
    async migrate() {
      await pool.query(`create table if not exists ${table} (key text primary key, payload jsonb not null, expires_at bigint not null)`);
    },
    async put(key, payload, expiresAt) {
      await pool.query(`insert into ${table} values ($1,$2,$3) on conflict (key) do update set payload=excluded.payload, expires_at=excluded.expires_at`, [key, JSON.stringify(payload), expiresAt]);
    },
    async get(key) {
      const { rows } = await pool.query(`select payload from ${table} where key=$1 and expires_at>$2`, [key, Date.now()]);
      return rows[0]?.payload || null;
    },
    async consume(key) {
      const { rows } = await pool.query(`delete from ${table} where key=$1 returning payload,expires_at`, [key]);
      return Number(rows[0]?.expires_at) > Date.now() ? rows[0].payload : null;
    },
    async remove(key) { await pool.query(`delete from ${table} where key=$1`, [key]); }
  };
}

/** For isolated development/tests only. Never selected implicitly in a deployment. */
function createMemoryWorkspaceStore() {
  const entries = new Map();
  return {
    async migrate() {},
    async put(key, value, expiry) { entries.set(key, { value: structuredClone(value), expiry }); },
    async get(key) { const row = entries.get(key); return row?.expiry > Date.now() ? structuredClone(row.value) : null; },
    async consume(key) { const row = entries.get(key); entries.delete(key); return row?.expiry > Date.now() ? structuredClone(row.value) : null; },
    async remove(key) { entries.delete(key); }
  };
}

function credentialCipher(secret) {
  if (!secret || secret.length < 32) throw new Error('Workspace encryption requires a secret of at least 32 characters.');
  const key = crypto.createHash('sha256').update(secret).digest();
  return {
    seal(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
    },
    open(value) {
      const bytes = Buffer.from(value, 'base64url'), cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    }
  };
}

function createWorkspaceProvider({ appId, sourceOrigin, store, getUser }) {
  const origin = new URL(sourceOrigin).origin;
  const callback = `${origin}/workspace/connected`;
  const router = express.Router();
  router.use('/api/workspace', express.json({ limit: '16kb' }), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Exchange/revoke use server-held credentials and do not accept cookie identity.
    if (!['GET','HEAD'].includes(req.method) && req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Request origin does not match.' });
    next();
  });
  router.get('/api/workspace/me', safe(async (req, res) => {
    const user = req.session?.userId && await getUser(req.session.userId);
    res.status(user ? 200 : 401).json(user ? { user } : { error: 'Sign into this app first.' });
  }));
  router.post('/api/workspace/authorize', safe(async (req, res) => {
    if (!req.session?.userId || !await getUser(req.session.userId)) throw fail('Sign into this app first.', 401);
    const { challenge, state, redirectUri, sourceOwner } = req.body || {};
    if (redirectUri !== callback || !/^[\w-]{43}$/.test(challenge || '') || !/^[\w-]{43}$/.test(state || '') || typeof sourceOwner !== 'string' || sourceOwner.length > 160) throw fail('Invalid connection request.');
    const code = random();
    await store.put(`code:${hash(code)}`, { appId, userId: req.session.userId, sourceOwner, challenge, state, redirectUri }, Date.now() + 120000);
    res.json({ code, state, redirectUri });
  }));
  router.post('/api/workspace/exchange', safe(async (req, res) => {
    const { code, verifier, state, redirectUri } = req.body || {};
    if (typeof code !== 'string' || typeof verifier !== 'string') throw fail('Invalid connection code.', 401);
    const key = `code:${hash(code)}`, pending = await store.get(key);
    if (!pending || pending.challenge !== hash(verifier) || pending.state !== state || pending.redirectUri !== redirectUri) throw fail('Connection expired or mismatched.', 401);
    const consumed = await store.consume(key);
    if (!consumed) throw fail('Connection code was already used.', 401);
    const token = random(), expiresAt = Date.now() + 90 * 86400000;
    const grant = { appId, userId: consumed.userId, sourceOwner: consumed.sourceOwner, expiresAt };
    await store.put(`grant:${hash(token)}`, grant, expiresAt);
    res.json({ token, ...grant });
  }));
  async function readGrant(req) {
    const token = req.get('authorization')?.match(/^Bearer ([\w-]{43})$/)?.[1];
    if (!token) return null;
    const grant = await store.get(`grant:${hash(token)}`);
    if (!grant || grant.appId !== appId || !await getUser(grant.userId)) return null;
    return { grant, token };
  }
  router.post('/api/workspace/revoke', safe(async (req, res) => {
    const found = await readGrant(req);
    if (found) await store.remove(`grant:${hash(found.token)}`);
    res.json({ ok: true });
  }));
  // Authenticate API calls without creating or overwriting the standalone cookie session.
  router.use('/api', safe(async (req, res, next) => {
    if (!/^Bearer [\w-]{43}$/.test(req.get('authorization') || '')) return next();
    const found = await readGrant(req);
    if (!found) throw fail('Reconnect this app.', 401);
    if (/^\/auth\//.test(req.path) && req.path !== '/auth/me') throw fail('Account changes require the standalone app.', 403);
    const previous = req.session, previousId = req.sessionID;
    req.sessionID = undefined;
    req.session = { userId: found.grant.userId };
    req.workspaceGrant = found.grant;
    // express-session may inspect req.session when finishing the response.
    const end = res.end;
    res.end = function (...args) { req.session = previous; req.sessionID = previousId; return end.apply(this, args); };
    return next();
  }));
  router.get('/workspace/connect', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self' https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; frame-src https:; frame-ancestors 'none'`);
    res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Source Studio</title><main style="max-width:440px;margin:10vh auto;font:17px system-ui;padding:24px"><h1>Connect to Source Studio</h1><p id="message">Checking your account...</p><div id="login"></div><button id="connect" hidden>Connect this account</button></main><script type="module" src="/workspace/connect.js"></script>`);
  });
  router.get('/workspace/connect.js', (_req, res) => res.type('js').send(`
    import { initClerkAuth } from '/workspace/auth.js';
    const params=new URLSearchParams(location.hash.slice(1));
    history.replaceState(null,'',location.pathname);
    const request=Object.fromEntries(params), message=document.querySelector('#message'), button=document.querySelector('#connect');
    async function identify(){const response=await fetch('/api/workspace/me');if(!response.ok)return false;const {user}=await response.json();message.textContent='Connect '+(user.email||user.id)+' to Source Studio?';button.hidden=false;return true;}
    if(!await identify())initClerkAuth({el:document.querySelector('#login'),onSignedIn:identify,onUnavailable:()=>message.textContent='Sign in to this app in another tab, then reopen this connection.',onError:e=>message.textContent=e.message});
    button.onclick=async()=>{button.disabled=true;try{const response=await fetch('/api/workspace/authorize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});const result=await response.json();if(!response.ok)throw Error(result.error);location.replace(result.redirectUri+'#'+new URLSearchParams({code:result.code,state:result.state,app:${JSON.stringify(appId)}}));}catch(e){message.textContent=e.message;button.disabled=false;}};
  `));
  router.get('/workspace/auth.js', (_req, res) => res.sendFile(require('node:path').resolve(__dirname, '../browser/index.js')));
  router.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.status ? error.message : 'Workspace connection failed.' }));
  return router;
}

module.exports = { createWorkspaceProvider, createPgWorkspaceStore, createMemoryWorkspaceStore, credentialCipher, hash, random };
