"use strict";

// Token verification + identity normalization, extracted from
// daily-command-center server.js /api/auth/clerk-sync (the reference
// implementation). Semantics are locked:
//   - the bearer token is verified against the Clerk secret key
//   - ONLY a VERIFIED email may key account identity. findOrCreateUser
//     implementations adopt existing local accounts by email, so trusting an
//     unverified address would let an attacker claim someone else's account
//     by signing up with their email. Unverified => treated as "no email".
//   - email-code users have no externalAccounts, so provider falls back to
//     "clerk" rather than an OAuth provider name.

const { verifyToken } = require("@clerk/backend");

async function verifyAndNormalize({ token, secretKey, clerkClient }) {
  const payload = await verifyToken(token, { secretKey });
  const clerkUserId = payload.sub;
  if (!clerkUserId) throw new Error("Invalid token: no subject");

  const cu = await clerkClient.users.getUser(clerkUserId);
  const primaryEmailObj =
    cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ||
    cu.emailAddresses[0] ||
    null;
  const rawEmail = primaryEmailObj?.emailAddress || null;
  const isVerified = (e) => e && e.verification && e.verification.status === "verified";
  const email =
    (isVerified(primaryEmailObj)
      ? primaryEmailObj
      : cu.emailAddresses.find(isVerified) || null)?.emailAddress || null;
  const displayName =
    [cu.firstName, cu.lastName].filter(Boolean).join(" ") ||
    (rawEmail ? rawEmail.split("@")[0] : null);
  const avatarUrl = cu.imageUrl || null;
  const rawProvider = (cu.externalAccounts?.[0]?.provider || "").replace(/^oauth_/, "");
  const provider = rawProvider || "clerk";

  return { externalId: clerkUserId, email, displayName, avatarUrl, provider };
}

module.exports = { verifyAndNormalize };
