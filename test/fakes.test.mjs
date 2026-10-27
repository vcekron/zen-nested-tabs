import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakes } from "./fakes.mjs";

let f, normal;

beforeEach(() => {
  f = installFakes();
  normal = f.space("w").normal;
});

test("folders are children of their list and own their container", () => {
  const F = f.folder("F", normal);
  const t = f.tab("t", F.container);
  assert.deepEqual([...normal.children], [F]);
  assert.equal(t.parentElement.parentElement, F);
  assert.equal(t.group, F);
});

test("moving a tab after a folder places it after the folder's contents", () => {
  const A = f.tab("A", normal);
  const F = f.folder("F", normal);
  f.tab("X", F.container);
  const B = f.tab("B", normal);
  gBrowser.moveTabAfter(A, F);
  assert.equal(f.order(), "X A B");
  assert.deepEqual([...normal.children], [F, A, B]);
});

test("tabs created in a folder's container sit inside the folder", () => {
  f.tab("A", normal);
  const F = f.folder("F", normal);
  f.tab("B", normal);
  f.tab("X", F.container);
  assert.equal(f.order(), "A X B");
});

test("split groups hold their tabs", () => {
  const S = f.split("S", normal);
  const Y = f.tab("Y", S);
  assert.deepEqual([...normal.children], [S]);
  assert.deepEqual(S.tabs, [Y]);
  assert.equal(Y.group, S);
  assert.equal(gBrowser.isTab(S), false);
});

test("cross-list moves are recorded, external ones are not", () => {
  const pinned = f.space("w").pinned;
  const A = f.tab("A", normal);
  const P = f.tab("P", pinned, { pinned: true });
  gBrowser.moveTabAfter(A, P);
  assert.equal(f.violations.length, 1);
  f.externalMove(A, f.tab("B", normal), true);
  assert.equal(f.violations.length, 1);
});

test("SessionStore only stores strings", () => {
  const t = f.tab("t", normal);
  assert.throws(() => SessionStore.setCustomTabValue(t, "k", 1), TypeError);
  SessionStore.setCustomTabValue(t, "k", "1");
  assert.equal(SessionStore.getCustomTabValue(t, "k"), "1");
});

test("undoing an unknown id returns undefined", () => {
  assert.equal(SessionStore.undoCloseById(42), undefined);
});

test("prefs and windows are configurable", () => {
  assert.equal(Services.prefs.getIntPref("browser.sessionstore.max_tabs_undo", 25), 25);
  f.prefs.set("browser.sessionstore.max_tabs_undo", 3);
  assert.equal(Services.prefs.getIntPref("browser.sessionstore.max_tabs_undo", 25), 3);
  assert.deepEqual([...Services.wm.getEnumerator("navigator:browser")], [window]);
});
