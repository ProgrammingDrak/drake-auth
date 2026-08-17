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
  rootBox: { width: "100%", maxWidth: "100%", minWidth: "0" },
  cardBox: {
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    boxShadow: "none",
    border: "none",
  },
  card: {
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    boxShadow: "none",
    border: "none",
    backgroundColor: "transparent",
    padding: "0",
  },
  main: { width: "100%", maxWidth: "100%", minWidth: "0" },
  form: { width: "100%", maxWidth: "100%", minWidth: "0" },
  formFieldRow: { width: "100%", maxWidth: "100%", minWidth: "0" },
  formFieldInput: { width: "100%", maxWidth: "100%", minWidth: "0" },
  formButtonPrimary: { width: "100%", maxWidth: "100%", minWidth: "0" },
  socialButtonsBlockButton: { width: "100%", maxWidth: "100%", minWidth: "0" },
};

let providerOnlyMountId = 0;

function escapeCssIdentifier(value) {
  if (globalThis.CSS && typeof globalThis.CSS.escape === "function") return globalThis.CSS.escape(value);
  const string = String(value);
  const length = string.length;
  const first = string.charCodeAt(0);
  let result = "";
  for (let index = 0; index < length; index += 1) {
    const code = string.charCodeAt(index);
    if (code === 0x0000) {
      result += "\uFFFD";
    } else if (
      (code >= 0x0001 && code <= 0x001f) || code === 0x007f ||
      (index === 0 && code >= 0x0030 && code <= 0x0039) ||
      (index === 1 && code >= 0x0030 && code <= 0x0039 && first === 0x002d)
    ) {
      result += `\\${code.toString(16)} `;
    } else if (index === 0 && code === 0x002d && length === 1) {
      result += "\\-";
    } else if (
      code >= 0x0080 || code === 0x002d || code === 0x005f ||
      (code >= 0x0030 && code <= 0x0039) ||
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a)
    ) {
      result += string.charAt(index);
    } else {
      result += `\\${string.charAt(index)}`;
    }
  }
  return result;
}

function providerOnlyCss(id) {
  const mount = `#${escapeCssIdentifier(id)}`;
  return `
${mount} .cl-signIn-start .cl-header,
${mount} .cl-signIn-start .cl-form,
${mount} .cl-signIn-start .cl-dividerRow,
${mount} .cl-signIn-start .cl-footer {
  display: none !important;
}`;
}

// Clerk reuses its form element for MFA, password reset, and other OAuth
// continuation challenges. Scope provider-only hiding to the initial SignIn
// state so those security steps stay visible.
function installProviderOnlyLayout(el) {
  const assignedId = !el.id;
  if (assignedId) el.id = `drake-auth-provider-only-${++providerOnlyMountId}`;
  const mountId = el.id;
  const style = document.createElement("style");
  style.setAttribute("data-drake-auth-provider-only", "");
  style.textContent = providerOnlyCss(mountId);
  document.head.appendChild(style);
  return () => {
    if (assignedId && el.id === mountId) el.removeAttribute("id");
    style.remove();
  };
}

export async function initClerkAuth({
  el,
  configUrl = "/api/auth/config",
  syncUrl = "/api/auth/clerk-sync",
  appearance = undefined,
  providerOnly = false,
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
  let removeProviderOnlyLayout = () => {};
  if (el) {
    if (providerOnly) removeProviderOnlyLayout = installProviderOnlyLayout(el);
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
      removeProviderOnlyLayout();
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
