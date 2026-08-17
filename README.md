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
npm i github:ProgrammingDrak/drake-auth#v0.2.1
```

Pin a tag. `./server` is CJS (works from CJS and ESM apps); `./browser`,
`./react`, and `./next` are buildless ESM.

**Two doors, one standard:**
- `drake-auth/server` + `drake-auth/browser|react` — Express apps. Clerk at
  the front door only; the app mints its own pg-backed cookie session
  (token-sync flow).
- `drake-auth/next` — Next.js apps. Clerk's middleware IS the session
  (`@clerk/nextjs` peer dep); exports `createAdminClerkMiddleware()` and the
  email-allowlist helpers (`getAllowedEmails`, `isAllowedEmail`,
  `getAdminEmail`). No app session, no users table required.

## Use

New app? Follow `docs/CLERK-APP-CHECKLIST.md` top to bottom — it covers the
per-app Clerk dashboard setup and the three integration points:

1. `installSessions(app, …)` — trust proxy, secure cookies, pg session store.
2. `createClerkAuth({ …, findOrCreateUser })` — mounts `/api/auth/config`,
   `/api/auth/clerk-sync`, and (dev only) `/api/auth/dev-login`.
3. `initClerkAuth` / `<ClerkSignIn/>` on the sign-in screen, and
   `clerkSignOut()` alongside the app's logout.

### One login surface

Apps that keep an app-owned username/email and password path must render one
login card in this order:

1. Enabled Clerk social providers, such as Google
2. A visible `or use your username or email` separator
3. The app-owned credential form

Do not hide the credential form behind a toggle and do not swap between a Clerk
page and an app page. The fallback must remain visible when Clerk is available,
loading, or temporarily unavailable. Set `providerOnly: true` to keep Clerk's
provider buttons while the app owns the credential fields:

```js
import { initClerkAuth, chromelessElements } from "drake-auth/browser";

await initClerkAuth({
  el: document.getElementById("clerk-sign-in"),
  appearance: {
    variables: { colorPrimary: "#3b82f6" },
    elements: chromelessElements,
  },
  providerOnly: true,
  onUnavailable: (reason) => {
    // Keep the credential form visible. Hide only the empty provider region
    // for "no-key", or show a compact provider-unavailable message.
  },
});
```

Apps that use Clerk for every enabled sign-in method should continue using
`chromelessElements` and should not render a second credential form.

`providerOnly` removes Clerk's initial header, footer, and built-in credential
form, but it deliberately restores Clerk's MFA, reset, and other continuation
forms after a provider starts authentication. The host card must provide its
own visible heading, an accessible label for the provider region, and announced
loading, unavailable, and error states. Keep those messages next to the
provider region without displacing or hiding the credential fallback.

For shared Sign in/Register cards, change the field label, placeholder, and
separator with the active mode. Sign in may say `Username or email` and `or use
your username or email`; username-only registration should say `Username` and
`or create with a username` so the UI never invites an email it will reject.

Current consumers include dnd-story-engine and DCC. DCC keeps Google OAuth and
its app-owned credential fallback; that provider choice remains per-app Clerk
configuration rather than shared package code.
