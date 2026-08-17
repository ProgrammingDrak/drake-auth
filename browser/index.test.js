import test from "node:test";
import assert from "node:assert/strict";

import { chromelessElements, initClerkAuth } from "./index.js";

test("chromeless widget elements stay constrained to their host card", () => {
  for (const key of ["rootBox", "cardBox", "card", "main", "form", "socialButtonsBlockButton"]) {
    assert.equal(chromelessElements[key].width, "100%");
    assert.equal(chromelessElements[key].maxWidth, "100%");
    assert.equal(chromelessElements[key].minWidth, "0");
  }
});

test("provider-only layout hides only the initial Clerk form", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalCss = globalThis.CSS;
  const styles = [];
  let unmounted = false;

  const clerk = {
    user: null,
    load: async () => {},
    mountSignIn: (target) => { target.className = "cl-rootBox cl-signIn-root"; },
    unmountSignIn: () => { unmounted = true; },
    addListener: () => () => {},
  };
  globalThis.window = { Clerk: clerk, location: { pathname: "/login" } };
  globalThis.fetch = async () => ({ json: async () => ({ clerkPublishableKey: "pk_test_fake" }) });
  globalThis.document = {
    createElement: () => ({
      textContent: "",
      setAttribute() {},
      remove() { this.removed = true; },
    }),
    head: { appendChild: (style) => styles.push(style) },
  };
  const el = { id: "", removeAttribute: (name) => { if (name === "id") el.id = ""; } };

  try {
    const controller = await initClerkAuth({ el, providerOnly: true });
    assert.match(el.id, /^drake-auth-provider-only-/);
    assert.equal(el.className, "cl-rootBox cl-signIn-root");
    assert.equal(styles.length, 1);
    assert.match(styles[0].textContent, new RegExp(`#${el.id} \\.cl-signIn-start \\.cl-form`));
    assert.match(styles[0].textContent, /\.cl-signIn-start \.cl-form/);
    assert.doesNotMatch(styles[0].textContent, /provider-only-[^ ]+ \.cl-form/);
    controller.unmount();
    assert.equal(el.id, "");
    assert.equal(styles[0].removed, true);
    assert.equal(unmounted, true);

    globalThis.CSS = undefined;
    const callerOwned = { id: "123:login", removeAttribute: () => assert.fail("caller-owned ID must be preserved") };
    const fallbackController = await initClerkAuth({ el: callerOwned, providerOnly: true });
    assert.equal(callerOwned.id, "123:login");
    assert.match(styles[1].textContent, /#\\31 23\\:login \.cl-signIn-start \.cl-form/);
    fallbackController.unmount();
    assert.equal(callerOwned.id, "123:login");
    assert.equal(styles[1].removed, true);

    let escapedValue = null;
    globalThis.CSS = { escape: (value) => { escapedValue = value; return "native-escaped"; } };
    const nativeOwned = { id: "native:id", removeAttribute: () => assert.fail("caller-owned ID must be preserved") };
    const nativeController = await initClerkAuth({ el: nativeOwned, providerOnly: true });
    assert.equal(escapedValue, "native:id");
    assert.match(styles[2].textContent, /#native-escaped \.cl-signIn-start \.cl-form/);
    nativeController.unmount();
    assert.equal(nativeOwned.id, "native:id");
    assert.equal(styles[2].removed, true);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.CSS = originalCss;
  }
});
