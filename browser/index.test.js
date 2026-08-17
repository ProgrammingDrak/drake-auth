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
  const classes = new Set();
  const styles = [];
  let unmounted = false;

  const clerk = {
    user: null,
    load: async () => {},
    mountSignIn: () => {},
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
  const el = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };

  try {
    const controller = await initClerkAuth({ el, providerOnly: true });
    assert.equal(classes.has("drake-auth-provider-only"), true);
    assert.equal(styles.length, 1);
    assert.match(styles[0].textContent, /\.cl-signIn-start \.cl-form/);
    assert.doesNotMatch(styles[0].textContent, /provider-only \.cl-form/);
    controller.unmount();
    assert.equal(classes.size, 0);
    assert.equal(styles[0].removed, true);
    assert.equal(unmounted, true);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});
