// drake-auth/next — the Next.js door. Same standard as drake-auth/server
// (Clerk at the edge, email-code passwordless by default, per-app Clerk
// application), mounted the Next-native way: Clerk's middleware IS the
// session layer, so unlike the Express door there is no app-owned cookie
// session or token-sync endpoint. Identity checks happen in middleware and
// server components via @clerk/nextjs (peer dependency).
//
// Reference consumer: faesfiligree (admin portal, email allowlist).

import { clerkMiddleware, createRouteMatcher, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// ── Email allowlist (app-side source of truth, mirrors the Clerk
// instance-level allowlist). Fails CLOSED: no allowlist configured => deny.
export function getAllowedEmails(envVar = "ADMIN_ALLOWED_EMAILS") {
  return (process.env[envVar] || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email, envVar = "ADMIN_ALLOWED_EMAILS") {
  if (!email) return false;
  const allowed = getAllowedEmails(envVar);
  if (allowed.length === 0) return false;
  return allowed.includes(email.toLowerCase());
}

// Returns the signed-in user's primary email if allowlisted, otherwise null.
// Use in server components / route handlers under the protected area.
export async function getAdminEmail(envVar = "ADMIN_ALLOWED_EMAILS") {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  return isAllowedEmail(email, envVar) ? email : null;
}

// ── Middleware factory: protect an area behind Clerk sign-in.
// The sign-in surface (loginRoute) stays public; everything matching
// protectedRoute requires a Clerk session and redirects to loginPath
// otherwise. Email-allowlist enforcement belongs in the protected layout
// (where the user object is available), on top of this gate.
//
//   // middleware.ts
//   import { createAdminClerkMiddleware } from "drake-auth/next";
//   export default createAdminClerkMiddleware();
//   export const config = { matcher: ["/admin/:path*", "/(api|trpc)(.*)"] };
export function createAdminClerkMiddleware({
  loginRoute = "/admin/login(.*)",
  protectedRoute = "/admin(.*)",
  loginPath = "/admin/login",
} = {}) {
  const isLoginRoute = createRouteMatcher([loginRoute]);
  const isProtectedRoute = createRouteMatcher([protectedRoute]);

  return clerkMiddleware(async (auth, request) => {
    if (isLoginRoute(request)) {
      return NextResponse.next();
    }
    if (isProtectedRoute(request)) {
      const { userId } = await auth();
      if (!userId) {
        return NextResponse.redirect(new URL(loginPath, request.url));
      }
    }
    return NextResponse.next();
  });
}
