// drake-auth/browser — framework-agnostic sign-in flow (ESM, no build step).
//
// Reproduces the daily-command-center login.html flow:
//   fetch {configUrl} -> null key => onUnavailable("no-key")
//   decode the Frontend API host from the publishable key
//     (pk_test_<base64("<fapi-host>$")>)
//   inject https://<fapi>/npm/@clerk/clerk-js@5/dist/clerk.browser.js
//   clerk.load(); already signed in => sync immediately, else mountSignIn
//   sync = POST {syncUrl} with Authorization: Bearer <clerk session token>,
//   which mints the app's own cookie session; then onSignedIn(result).

let clerkLoadPromise = null;

function decodeFapiHost(pk) {
  try {
    return atob(pk.split("_")[2] || "").replace(/\$+$/, "") || null;
  } catch {
    return null;
  }
}

async function loadClerkJs(publishableKey) {
  if (window.Clerk) return window.Clerk;
  if (!clerkLoadPromise) {
    const fapiHost = decodeFapiHost(publishableKey);
    if (!fapiHost) throw new Error("Could not decode Clerk frontend API host");
    clerkLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://" + fapiHost + "/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
      s.async = true;
      s.crossOrigin = "anonymous";
      s.setAttribute("data-clerk-publishable-key", publishableKey);
      s.onload = () => resolve(window.Clerk);
      s.onerror = () => {
        clerkLoadPromise = null;
        reject(new Error("Failed to load Clerk"));
      };
      document.head.appendChild(s);
    });
  }
  return clerkLoadPromise;
}

async function fetchPublishableKey(configUrl) {
  try {
    const cfg = await (await fetch(configUrl, { credentials: "include" })).json();
    return cfg && cfg.clerkPublishableKey ? cfg.clerkPublishableKey : null;
  } catch {
    return null;
  }
}

// Renders Clerk's widget chrome-less so it sits inside the app's own card
// (no card-in-a-card). Spread into your own appearance and add `variables`
// for the app palette.
export const chromelessElements = {
  rootBox: { width: "100%" },
  cardBox: { boxShadow: "none", border: "none" },
  card: {
    boxShadow: "none",
    border: "none",
    backgroundColor: "transparent",
    padding: "0",
  },
};

export async function initClerkAuth({
  el,
  configUrl = "/api/auth/config",
  syncUrl = "/api/auth/clerk-sync",
  appearance = undefined,
  redirectUrl = typeof window !== "undefined" ? window.location.pathname : "/",
  onSignedIn = () => {},
  onUnavailable = () => {},
  onError = () => {},
} = {}) {
  const pk = await fetchPublishableKey(configUrl);
  if (!pk) {
    onUnavailable("no-key");
    return { clerk: null, unmount: () => {} };
  }

  let clerk;
  try {
    clerk = await loadClerkJs(pk);
    await clerk.load();
  } catch (e) {
    onUnavailable("load-failed");
    onError(e);
    return { clerk: null, unmount: () => {} };
  }

  let syncing = false;
  let unmounted = false;
  async function syncSession() {
    if (syncing || unmounted) return;
    syncing = true;
    try {
      const token = await clerk.session.getToken();
      const res = await fetch(syncUrl, {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        credentials: "include",
      });
      if (res.ok) {
        onSignedIn(await res.json().catch(() => ({})));
      } else {
        const data = await res.json().catch(() => ({}));
        syncing = false;
        onError(new Error(data.error || "Sign-in could not be completed."));
      }
    } catch (e) {
      syncing = false;
      onError(e);
    }
  }

  // Returning visitor already signed in to Clerk — sync straight through.
  if (clerk.user) {
    await syncSession();
    return { clerk, unmount: () => { unmounted = true; } };
  }

  let mounted = false;
  if (el) {
    clerk.mountSignIn(el, {
      appearance,
      forceRedirectUrl: redirectUrl,
      signUpForceRedirectUrl: redirectUrl,
    });
    mounted = true;
  }
  const removeListener = clerk.addListener(({ user }) => {
    if (user) syncSession();
  });

  return {
    clerk,
    unmount: () => {
      unmounted = true;
      if (typeof removeListener === "function") removeListener();
      if (mounted && el) {
        try { clerk.unmountSignIn(el); } catch { /* already gone */ }
      }
    },
  };
}

// Must accompany the app's own logout endpoint. Without this, the lingering
// Clerk session auto-resyncs on the next visit to the sign-in screen and
// logout appears broken.
export async function clerkSignOut({ configUrl = "/api/auth/config" } = {}) {
  try {
    let clerk = window.Clerk;
    if (!clerk) {
      const pk = await fetchPublishableKey(configUrl);
      if (!pk) return; // Clerk not configured — nothing to sign out of
      clerk = await loadClerkJs(pk);
      await clerk.load();
    }
    if (clerk.user) await clerk.signOut();
  } catch {
    // best-effort: app session is already destroyed by the caller
  }
}
