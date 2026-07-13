"use strict";

// drake-auth/server — Drake's standard auth kit, server side.
//
// Architecture (from daily-command-center, the reference implementation):
// Clerk is only an identity provider at the edge. The browser widget produces
// a Clerk session token, POSTs it to {basePath}/clerk-sync, the server
// verifies it, maps the external identity to a local user via the
// app-supplied findOrCreateUser, and mints the app's OWN session cookie.
// Every downstream route keeps working off req.session — Clerk is never on
// the hot path after sign-in.
//
// Graceful degradation: with no Clerk keys, auth.enabled is false, /config
// returns a null key, and the browser module reports "no-key" so apps can
// show a dev-bypass button (or nothing) instead of a broken widget.

const { verifyAndNormalize } = require("./clerk-sync.cjs");
const { installSessions } = require("./sessions.cjs");

function createClerkAuth(opts = {}) {
  const {
    publishableKey = null,
    secretKey = null,
    basePath = "/api/auth",
    findOrCreateUser,
    onSession = (req, result) => {
      req.session.userId = result.userId;
    },
    devBypass = null,
  } = opts;

  if (typeof findOrCreateUser !== "function") {
    throw new Error("createClerkAuth: opts.findOrCreateUser is required");
  }

  let clerkClient = null;
  if (secretKey) {
    try {
      clerkClient = require("@clerk/backend").createClerkClient({ secretKey });
    } catch (e) {
      console.warn("[drake-auth] @clerk/backend unavailable; Clerk login disabled:", e.message);
    }
  }
  const enabled = Boolean(clerkClient && publishableKey);

  const express = require("express");
  const router = express.Router();

  // Public config for the sign-in page: whether the Clerk widget is available
  // and which publishable key to mount it with.
  router.get(`${basePath}/config`, (req, res) => {
    res.json({ clerkPublishableKey: enabled ? publishableKey : null });
  });

  async function establishSession(req, identity) {
    const result = await findOrCreateUser(identity);
    if (!result || result.userId == null) {
      throw new Error("findOrCreateUser must return { userId, ... }");
    }
    await onSession(req, result);
    const { userId, ...extra } = result;
    return extra;
  }

  router.post(`${basePath}/clerk-sync`, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: "Sign-in is not configured" });
    try {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Missing token" });

      const identity = await verifyAndNormalize({ token, secretKey, clerkClient });
      const extra = await establishSession(req, identity);
      res.json({ ok: true, ...extra });
    } catch (e) {
      console.error("[drake-auth] sync error:", e.message);
      res.status(401).json({ error: "Could not verify sign-in" });
    }
  });

  // Dev bypass: a stub identity through the SAME findOrCreateUser/onSession
  // path, so keyless local dev exercises the real code. Never in production.
  const bypassActive =
    devBypass && devBypass.enabled && process.env.NODE_ENV !== "production";
  if (bypassActive) {
    router.post(`${basePath}/dev-login`, async (req, res) => {
      try {
        const identity = {
          externalId: "dev_local",
          email: "dev@localhost",
          displayName: "Local Dev",
          avatarUrl: null,
          provider: "dev",
          ...devBypass.user,
        };
        const extra = await establishSession(req, identity);
        res.json({ ok: true, ...extra });
      } catch (e) {
        console.error("[drake-auth] dev-login error:", e.message);
        res.status(500).json({ error: e.message });
      }
    });
    console.log(`[drake-auth] dev bypass active: POST ${basePath}/dev-login`);
  }

  function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    next();
  }

  return { router, requireAuth, enabled, devBypass: Boolean(bypassActive) };
}

module.exports = { createClerkAuth, installSessions, verifyAndNormalize };
