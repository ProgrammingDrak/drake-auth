"use strict";

// Session bootstrap that fixes the whole "works locally, logs everyone out on
// Railway" class of bugs once, for every app:
//   - trust proxy 1        (secure cookies behind hosted reverse proxies)
//   - secure: "auto"       (HTTPS in prod, plain HTTP locally)
//   - sameSite: "lax", httpOnly: true
//   - pg-backed store when a Pool is supplied (sessions survive deploys)
//   - hard failure on a missing/known-insecure secret in production

const session = require("express-session");

function installSessions(app, opts = {}) {
  const {
    name,
    secret,
    pool = null,
    schemaName = undefined,
    tableName = "session",
    cookie = {},
    insecureSecrets = [],
  } = opts;

  if (!name) throw new Error("installSessions: opts.name (cookie name) is required");
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && (!secret || insecureSecrets.includes(secret))) {
    throw new Error(
      "installSessions: SESSION_SECRET is missing or set to an insecure default in production"
    );
  }

  app.set("trust proxy", 1);

  let store; // undefined => express-session MemoryStore
  if (pool) {
    const pgSession = require("connect-pg-simple")(session);
    store = new pgSession({
      pool,
      schemaName,
      tableName,
      createTableIfMissing: true,
    });
  } else if (isProd) {
    console.warn(
      "[drake-auth] WARNING: production is running the in-memory session store. " +
        "Every deploy/restart will log all users out. Pass a pg Pool to installSessions."
    );
  }

  const middleware = session({
    name,
    secret: secret || "drake-auth-dev-only-secret",
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: 1000 * 60 * 60 * 24 * 30,
      ...cookie,
    },
  });

  app.use(middleware);
  return middleware;
}

module.exports = { installSessions };
