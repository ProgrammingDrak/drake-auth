# drake-auth

Drake's standard auth kit. One identical plug-in for every app:

- **Clerk at the edge** — managed sign-in widget, **email-code passwordless by
  default** (enter email, get a 6-digit code; no passwords, no OAuth unless an
  app opts in via its own Clerk application config).
- **App-owned sessions downstream** — after the widget completes, the browser
  POSTs the Clerk token to `/api/auth/clerk-sync`; the server verifies it,
  maps the identity to a row in the app's own users table (link by verified
  email), and mints the app's own cookie session. Clerk is never on the hot
  path after sign-in.
- **Separate Clerk application per app** (own user pool), identical code.

Extracted from the daily-command-center reference implementation.

## Install

```
npm i github:ProgrammingDrak/drake-auth#v0.1.0
```

Pin a tag. `./server` is CJS (works from CJS and ESM apps); `./browser` and
`./react` are buildless ESM (Vite consumes them straight from node_modules).

## Use

New app? Follow `docs/CLERK-APP-CHECKLIST.md` top to bottom — it covers the
per-app Clerk dashboard setup and the three integration points:

1. `installSessions(app, …)` — trust proxy, secure cookies, pg session store.
2. `createClerkAuth({ …, findOrCreateUser })` — mounts `/api/auth/config`,
   `/api/auth/clerk-sync`, and (dev only) `/api/auth/dev-login`.
3. `initClerkAuth` / `<ClerkSignIn/>` on the sign-in screen, and
   `clerkSignOut()` alongside the app's logout.

First consumer: dnd-story-engine. DCC is the planned second (it keeps its
Google OAuth — that's per-app Clerk config, not code).
