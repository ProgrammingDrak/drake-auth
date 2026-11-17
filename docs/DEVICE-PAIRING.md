# Phone sign-in for glasses

Express apps can use `drake-auth/device-pairing` to let glasses receive an
app-owned session after the user signs in through the app on their phone.

The phone uses the app's ordinary Clerk sign-in, including Google. Each app
keeps its own users and session cookie. The glasses receive a fresh session
through the app's existing session adapter.

## Integration

Mount the pairing router after express-session. Allow its exact endpoints
through the application's authentication gate. The router authenticates phone
approval internally through `getAccount`.

```js
const { createDevicePairing, createPgDevicePairingStore } =
  require("drake-auth/device-pairing");

const store = createPgDevicePairingStore(pool);
const pairing = createDevicePairing({
  store,
  secret: sessionSecret,
  getAccount: req => resolveAccount(req.session.userId),
  resolveAccount,
  onSession: establishAppSession
});
app.use(pairing.router);
```

Both account adapters return the canonical app account with `userId` and a
human-readable `label`. Return null for missing accounts. The session adapter
sets the same user and workspace fields used by ordinary app sign-in.

The PostgreSQL store creates `auth_device_pairings` and
`auth_device_pairing_limits` on first use. They use the pool's current schema.
Review these additive schema changes before production rollout.

## Client flow

Every request uses POST, JSON, same-origin credentials, and the header
`X-Device-Pairing: 1`. Default route prefix is `/api/auth/device`.

- `/start` creates or resumes the glasses browser's five-minute request.
- `/status` returns waiting, approved, expired or connected.
- `/cancel` invalidates the request belonging to the glasses cookie.
- `/inspect` takes `{ code }` from the authenticated phone. It returns the
  matching code, current account label and a confirmation challenge.
- `/approve` takes `{ challenge }` after the user compares codes.
- `/redeem` runs on the glasses after approval. It regenerates the app session,
  reserves redemption atomically, saves the session, then returns success.

Poll status while the glasses page is visible. Pause on hide and use bounded
backoff after connection errors. A lost response after successful redemption
recovers through the authenticated cookie. A failed session save releases the
reservation and destroys the incomplete session. The glasses can request a new
code after a failed save or a server restart during finalization.

Codes are six digits. PostgreSQL stores their HMAC and a hash of the glasses
secret. The secret stays in the originating server-side session. PostgreSQL
locks serialize redemption across workers. Account changes invalidate phone
confirmation, and canonical account resolution runs again during redemption.
The account and session adapters receive the transaction client as their last
argument. Use that client for database work inside those adapters. The router
saves the session after releasing the transaction to avoid pool deadlocks.

IP and session limits persist in PostgreSQL. Cross-origin requests are rejected.
Use a correctly configured trusted proxy so `req.ip` reflects the caller.
The optional `origin` setting pins checks to a canonical public origin.

## Verification

The tests use a dedicated localhost database and temporary schemas.

```sh
AUTH_PAIRING_TEST_DATABASE_URL=postgresql://localhost/pairing_test node --test
```

Physical glasses and real Google sign-in require separate device acceptance.
