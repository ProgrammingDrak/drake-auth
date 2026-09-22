# First-party workspace connections

`drake-auth/workspace` links explicit authenticated app and Source Studio IDs.
It never matches accounts by email or creates a second app identity.

Install `createWorkspaceProvider` after sessions and before app API handlers.
Pass `appId`, exact `sourceOrigin`, `store`, and `getUser(id)`.
Use `createPgWorkspaceStore(pool, schema)` and await `migrate()` before requests.
The memory store is for explicit isolated development only.

The standalone `/workspace/connect` page uses the existing sign-in flow.
Codes expire after two minutes and allow one PKCE-bound exchange.
The exchange validates callback, state, app identity, and Source owner.
Only the Source server receives the 90-day delegated credential.
Provider storage hashes grants; Source encrypts them using `credentialCipher`.
Its secret requires at least 32 characters. Keep it outside Git.
Secret rotation requires reconnecting existing accounts.

| Route | Purpose |
| --- | --- |
| `GET /api/workspace/me` | Existing cookie identity |
| `POST /api/workspace/authorize` | Cookie-authorized, PKCE-bound code |
| `POST /api/workspace/exchange` | Server exchange with code and verifier |
| `POST /api/workspace/revoke` | Revoke remote authority without deleting work |

Delegated calls use the existing `req.session.userId` contract.
The middleware restores the standalone session when the response finishes.
Source cookies never travel upstream. Account mutations require the standalone app.
These mounts trust first-party code; they do not sandbox untrusted plugins.
Never cache account responses or log credentials and source contents.
