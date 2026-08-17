// drake-auth/react — thin React wrapper over drake-auth/browser.
// Plain ESM with React.createElement (no JSX) so consumers need zero
// transpile configuration for node_modules.

import React from "react";
import { initClerkAuth } from "../browser/index.js";

export { clerkSignOut, chromelessElements, initClerkAuth } from "../browser/index.js";

export function ClerkSignIn({
  appearance,
  providerOnly,
  onSignedIn,
  onUnavailable,
  onError,
  redirectUrl,
  configUrl,
  syncUrl,
  className,
}) {
  const ref = React.useRef(null);
  const cbs = React.useRef({ onSignedIn, onUnavailable, onError });
  cbs.current = { onSignedIn, onUnavailable, onError };

  React.useEffect(() => {
    let ctrl = null;
    let cancelled = false;
    initClerkAuth({
      el: ref.current,
      appearance,
      providerOnly,
      redirectUrl,
      configUrl,
      syncUrl,
      onSignedIn: (r) => cbs.current.onSignedIn && cbs.current.onSignedIn(r),
      onUnavailable: (why) => cbs.current.onUnavailable && cbs.current.onUnavailable(why),
      onError: (e) => cbs.current.onError && cbs.current.onError(e),
    }).then((c) => {
      if (cancelled) c.unmount();
      else ctrl = c;
    });
    return () => {
      cancelled = true;
      if (ctrl) ctrl.unmount();
    };
  }, []);

  return React.createElement("div", { ref, className });
}

// Lets apps decide up front whether to show a dev-bypass button (key null)
// or the Clerk widget.
export function useAuthConfig(configUrl = "/api/auth/config") {
  const [state, setState] = React.useState({ loading: true, clerkPublishableKey: null });
  React.useEffect(() => {
    let alive = true;
    fetch(configUrl, { credentials: "include" })
      .then((r) => r.json())
      .then((cfg) => alive && setState({ loading: false, clerkPublishableKey: cfg.clerkPublishableKey || null }))
      .catch(() => alive && setState({ loading: false, clerkPublishableKey: null }));
    return () => { alive = false; };
  }, [configUrl]);
  return state;
}
