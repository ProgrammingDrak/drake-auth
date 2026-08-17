# Per-app Clerk setup checklist

Every app gets its OWN Clerk application (own user pool) but identical code.
Default sign-in mode is **email verification code only** (passwordless). Any
deviation (e.g. DCC keeps Google OAuth) is per-app Clerk config, not code.

The clerk-cli can automate most of this; the dashboard path is listed for
clarity.

1. **Create the application.** Clerk Dashboard -> Create application, named
   after the app (e.g. "DND Story Engine").
2. **Identifiers & factors** (User & Authentication -> Email, Phone, Username):
   - Email address: ON, required identifier.
   - Email verification code: ON (sign-in and sign-up factor).
   - Password: OFF. Username: OFF. Phone: OFF. Passkeys: optional, default OFF.
3. **SSO connections:** disable all social providers for email-code-only apps.
   (Per-app override allowed; the SignIn widget renders exactly what the
   instance enables, so no code changes either way.)
4. **Keys -> env.** Copy `pk_test_...` / `sk_test_...` into the app's `.env`
   as `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`, and into the hosting
   provider's service variables (Railway).
5. **Optional restrictions:** Restrictions -> sign-up mode. For personal apps,
   consider Restricted + an allowlist so strangers can't create accounts.
6. **Production instances (only when an app actually needs it):**
   - The DEFAULT for Drake's personal apps is to run the dev-instance keys in
     production (the DCC precedent — works on `*.up.railway.app`). Known
     limits: "Development mode" badge on the widget, ~100-user cap, shared
     dev infra.
   - The proper upgrade path: put the app on a custom domain -> `clerk deploy`
     (creates the production instance) -> add the printed CNAME/DKIM records
     at the DNS provider. **If the zone is on Cloudflare the records must be
     DNS-only (grey cloud)** — orange-cloud proxying breaks Clerk's domain
     verification. Wait for `clerk deploy status` to verify, then swap
     `pk_live`/`sk_live` into the service env.

## App integration recap

Server (Express):

```js
const { createClerkAuth, installSessions } = require("drake-auth/server");

installSessions(app, {
  name: "<app>.sid",
  secret: process.env.SESSION_SECRET,
  pool,                       // pg Pool, or null for dev MemoryStore
  schemaName: "<app_schema>",
});

const auth = createClerkAuth({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  secretKey: process.env.CLERK_SECRET_KEY,
  findOrCreateUser: async ({ externalId, email, displayName }) => {
    // app-owned users table; MUST link by verified email, return { userId }
  },
  devBypass: { enabled: !process.env.CLERK_SECRET_KEY, user: { email: "dev@localhost" } },
});
app.use(auth.router);         // BEFORE the app's requireAuth gate
```

Browser (plain page or React):

```js
import { initClerkAuth, clerkSignOut, chromelessElements } from "drake-auth/browser";
// or
import { ClerkSignIn, clerkSignOut, chromelessElements } from "drake-auth/react";
```

If the app keeps its own username/email and password login, use the standard
single-card layout: Clerk social providers first, a plain `or` separator, and
the credential form immediately below. Keep both methods visible. Pass
`providerOnly: true` alongside `chromelessElements` so Clerk supplies only
the social provider row at the initial step and does not duplicate the app's
credential fields. Clerk continuation forms such as MFA and password reset
remain visible. If Clerk is unavailable, preserve the credential form and hide
only the empty provider region or show a compact provider-unavailable message.

The host card owns the accessible context that Clerk no longer renders. Give
the provider region an accessible label, keep a visible page heading, and
announce loading, unavailable, and error states with an appropriate live
region. A React consumer passes the same helper through the component:

```jsx
<ClerkSignIn providerOnly appearance={{ elements: chromelessElements }} />
```

Logout must call the app's `/api/auth/logout` AND `clerkSignOut()`.

Next.js apps (the second door):

```ts
// middleware.ts
import { createAdminClerkMiddleware } from "drake-auth/next";
export default createAdminClerkMiddleware();
export const config = { matcher: ["/admin/:path*", "/(api|trpc)(.*)"] };

// anywhere server-side
import { getAdminEmail, isAllowedEmail } from "drake-auth/next";
```

Env: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
`NEXT_PUBLIC_CLERK_SIGN_IN_URL=/admin/login` (and SIGN_UP_URL),
`ADMIN_ALLOWED_EMAILS=a@x.com,b@y.com`. The sign-in page mounts
`<SignIn/>` from `@clerk/nextjs` (see faesfiligree
`src/app/admin/login/[[...rest]]/page.tsx` for the reference).
