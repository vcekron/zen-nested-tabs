import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakes } from "./fakes.mjs";
import { TreeModel, KEYS } from "../js/model.mjs";

let f, model, w;
const make = (label, listNode, options = {}) => {
  const t = f.tab(label, listNode, { ...options, stored: { [KEYS.id]: label.toLowerCase() } });
  t.setAttribute("zen-workspace-id", options.space ?? "w");
  model.load(t);
  return t;
};
const tree = () => {
  const T = make("T", w.normal);
  const C1 = make("C1", w.normal);
  const G = make("G", w.normal);
  const C2 = make("C2", w.normal);
  make("Z", w.normal);
  model.setParent(C1, T);
  model.setParent(G, C1);
  model.setParent(C2, T);
  return { T, C1, G, C2 };
};

beforeEach(() => {
  f = installFakes();
  model = new TreeModel();
  w = f.space("w");
});

test("pinning a parent pins its subtree after it with the structure intact", () => {
  make("P", w.pinned, { pinned: true });
  const { T, C1, G, C2 } = tree();
  gBrowser.pinTab(T);
  model.applyListChanges();
  assert.equal(f.order(w.pinned), "P T C1 G C2");
  assert.ok([C1, G, C2].every(t => t.pinned));
  assert.equal(G._zttParentId, C1._zttId);
  assert.equal(C2._zttParentId, T._zttId);
  assert.equal(f.order(w.normal), "Z");
});

test("unpinning a parent out of a folder brings its subtree to the normal list", () => {
  const F = f.folder("F");
  const T = make("T", F.container, { pinned: true, group: F });
  const K = make("K", F.container, { pinned: true, group: F });
  model.setParent(K, T);
  make("Z", w.normal);
  gBrowser.unpinTab(T);
  model.applyListChanges();
  assert.equal(f.order(w.normal), "Z T K");
  assert.equal(K.group, null);
  assert.equal(K.pinned, false);
  assert.equal(K._zttParentId, T._zttId);
});

test("moving a parent to another space brings its subtree", () => {
  const v = f.space("v");
  const { T, C1, G, C2 } = tree();
  gZenWorkspaces.moveTabToWorkspace(T, "v");
  model.applyListChanges();
  assert.equal(f.order(v.normal), "T C1 G C2");
  assert.ok([C1, G, C2].every(t => t.getAttribute("zen-workspace-id") === "v"));
});

test("carry skips descendants already in the target list", () => {
  const F = f.folder("F");
  const { T, C1, G, C2 } = tree();
  model.recordOrder();
  F.addTabs([C2, T]);
  T.pinned = C2.pinned = true;
  model.applyListChanges();
  assert.equal(f.order(F.container), "T C1 G C2");
  assert.equal(C2._zttParentId, T._zttId);
  assert.equal(C1._zttParentId, T._zttId);
  assert.equal(gBrowser.tabs.filter(t => t.label === "C2").length, 1);
});

test("a parent dragged into Essentials goes alone; its children move up", () => {
  const A = make("A", w.normal);
  const { T, C1, C2 } = tree();
  model.setParent(T, A);
  T.setAttribute("zen-essential", "true");
  T.parentNode = f.list("essentials");
  model.applyListChanges();
  assert.equal(T._zttParentId, null);
  assert.equal(C1._zttParentId, A._zttId);
  assert.equal(C2._zttParentId, A._zttId);
  assert.equal(C1.parentNode, w.normal);
});

test("a tree in another space is found and kept", () => {
  const v = f.space("v");
  const P = make("P", v.normal, { space: "v" });
  const K = make("K", v.normal, { space: "v" });
  model.setParent(K, P);
  assert.equal(model.parentOf(K), P);
  assert.deepEqual(model.subtreeOf(P), [K]);
});

test("carrying into a pinned list of another space pins first, then moves space", () => {
  const v = f.space("v");
  const { T, C1 } = tree();
  T.pinned = true;
  T.setAttribute("zen-workspace-id", "v");
  f.externalMove(T, make("VP", v.pinned, { pinned: true, space: "v" }), true);
  model.applyListChanges();
  assert.equal(C1.parentNode, v.pinned);
  assert.equal(C1.getAttribute("zen-workspace-id"), "v");
  assert.equal(f.order(v.pinned), "VP T C1 G C2");
});

afterEach(() => assert.deepEqual(f.violations, [], "a move crossed lists"));
