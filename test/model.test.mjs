import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakes } from "./fakes.mjs";
import { TreeModel, KEYS } from "../js/model.mjs";
import { computeLayout } from "../js/layout.mjs";

let f, model, normal;
const build = spec => {
  const made = {};
  for (const [label, parent] of spec) {
    made[label] = f.tab(label, normal);
    model.load(made[label]);
  }
  for (const [label, parent] of spec) {
    if (parent) model.setParent(made[label], made[parent]);
  }
  return made;
};

beforeEach(() => {
  f = installFakes();
  model = new TreeModel();
  normal = f.list("normal");
});

test("isEligible excludes Essentials, Glance, empty and split-view tabs", () => {
  const plain = f.tab("plain", normal);
  const split = f.element({ attrs: { "split-view-group": "true" } });
  assert.equal(model.isEligible(plain), true);
  for (const attr of ["zen-essential", "zen-glance-tab", "zen-empty-tab"]) {
    assert.equal(model.isEligible(f.tab(attr, normal, { attrs: { [attr]: "true" } })), false, attr);
  }
  assert.equal(model.isEligible(f.tab("split", normal, { group: split })), false);
  const closing = f.tab("closing", normal);
  closing.closing = true;
  assert.equal(model.isEligible(closing), false);
});

test("setParent refuses a cycle", () => {
  const { A, B } = build([["A"], ["B", "A"]]);
  model.setParent(A, B);
  assert.equal(A._zttParentId, null);
});

test("descendantsOf lists the subtree in sidebar order within one list", () => {
  const { A, B, C, D } = build([["A"], ["B", "A"], ["C", "B"], ["D", "A"]]);
  const other = f.tab("X", f.list("pinned"));
  model.load(other);
  model.setParent(other, A);
  assert.deepEqual(model.descendantsOf(A), [B, C, D]);
  assert.deepEqual(model.subtreeOf(A), [B, C, D, other]);
});

test("moveSubtree moves the tab and its subtree after the target and expands its ancestors", () => {
  const { A, B, C, D } = build([["A"], ["B"], ["C", "B"], ["D"]]);
  model.setCollapsed(D, true);
  assert.equal(model.moveSubtree(B, D, D), true);
  assert.equal(f.order(), "A D B C");
  assert.equal(B._zttParentId, D._zttId);
  assert.equal(D._zttCollapsed, false);
});

test("nestUnder makes the tab the last child, after the parent's whole subtree", () => {
  const { A, X } = build([["A"], ["B", "A"], ["C", "B"], ["D"], ["X"]]);
  model.nestUnder(X, A);
  assert.equal(f.order(), "A B C X D");
  assert.equal(X._zttParentId, A._zttId);
});

test("leaveTree moves children up to the grandparent", () => {
  const { A, B, C, D } = build([["A"], ["B", "A"], ["C", "B"], ["D", "B"]]);
  model.leaveTree(B);
  assert.equal(B._zttParentId, null);
  assert.equal(C._zttParentId, A._zttId);
  assert.equal(D._zttParentId, A._zttId);
});

test("save never writes to a closing tab", () => {
  const t = f.tab("closing", normal);
  t.closing = true;
  t._zttId = "x";
  f.store.writes.length = 0;
  model.save(t);
  assert.deepEqual(f.store.writes, []);
});

test("load reads a pinned tab's tree values", () => {
  const t = f.tab("pinned", f.list("pinned"), {
    pinned: true,
    stored: { [KEYS.id]: "p1", [KEYS.parent]: "p0", [KEYS.collapsed]: "true", [KEYS.promotions]: '[{"from":"a","to":null}]' },
  });
  model.load(t);
  assert.equal(t._zttId, "p1");
  assert.equal(t._zttParentId, "p0");
  assert.equal(t._zttCollapsed, true);
  assert.deepEqual(t._zttPromotions, [{ from: "a", to: null }]);
});

test("a parent in another list is not live but its pointer is kept", () => {
  const { A, B } = build([["A"], ["B", "A"]]);
  model.moveAfter(A, f.tab("pin", f.list("pinned")));
  assert.equal(model.liveParent(B, model.idMap()), null);
  assert.equal(B._zttParentId, A._zttId);
});

test("repairOrder fixes a subtree split by a sibling", () => {
  build([["SWE"], ["VERK", "SWE"], ["RTX30", "VERK"], ["TAV", "SWE"], ["LEAF", "RTX30"], ["ZAG", "VERK"], ["NOM", "SWE"]]);
  model.repairOrder();
  assert.equal(f.order(), "SWE VERK RTX30 LEAF ZAG TAV NOM");
});

test("a collapsed parent whose children are not placed yet stays collapsed", () => {
  const { P, K } = build([["P"], ["K", "P"]]);
  model.setCollapsed(P, true);
  K._zttPending = true;
  const nodes = model.sidebarNodes();
  model.applyLayout(nodes, computeLayout(nodes));
  assert.equal(P._zttCollapsed, true);
});

test("applyLayout keeps each tab's revealed state", () => {
  const { K } = build([["P"], ["K", "P"]]);
  model.setCollapsed(gBrowser.tabs[0], true);
  K.selected = true;
  const nodes = model.sidebarNodes();
  model.applyLayout(nodes, computeLayout(nodes));
  assert.equal(K._zttRevealed, true);
});

test("save then load round-trips parent, collapsed and promotions", () => {
  const { A, B } = build([["A"], ["B", "A"], ["C", "B"]]);
  model.setCollapsed(B, true);
  B._zttPromotions = [{ from: "x", to: null }];
  model.save(B);
  const id = B._zttId;
  delete B._zttId;
  B._zttParentId = B._zttCollapsed = B._zttPromotions = undefined;
  model.load(B);
  assert.equal(B._zttId, id);
  assert.equal(B._zttParentId, A._zttId);
  assert.equal(B._zttCollapsed, true);
  assert.deepEqual(B._zttPromotions, [{ from: "x", to: null }]);
});

test("save deletes values that are empty", () => {
  const { B } = build([["A"], ["B", "A"]]);
  model.setParent(B, null);
  const last = key => f.store.writes.filter(([t, k]) => t === B && k === key).at(-1)?.[2];
  assert.equal(last(KEYS.parent), null);
  assert.equal(last(KEYS.collapsed), null);
  assert.equal(last(KEYS.promotions), null);
  assert.equal(f.values.get(B).has(KEYS.parent), false);
});

test("save never writes for a closing tab", () => {
  const { B } = build([["A"], ["B", "A"]]);
  B.closing = true;
  f.store.writes.length = 0;
  model.setParent(B, null);
  assert.deepEqual(f.store.writes, []);
});

test("closing and reopening around a nest cannot leave a cycle", () => {
  const stored = (label, id, parent) => {
    const t = f.tab(label, normal, { stored: parent ? { [KEYS.id]: id, [KEYS.parent]: parent } : { [KEYS.id]: id } });
    model.load(t);
    return t;
  };
  const X = stored("X", "x");
  const close = t => Object.assign(t, { closing: true, isConnected: false });
  close(stored("A", "a", "x"));
  close(stored("C", "c", "a"));
  const C = stored("C", "c", "a");
  assert.equal(model.nestUnder(X, C), true);
  const A = stored("A", "a", "x");
  assert.equal(model.inCycle(A), true);
  model.breakCycles();
  for (const t of [X, A, C]) {
    assert.equal(model.inCycle(t), false, t.label);
  }
  const cleared = [X, A, C].filter(t => !t._zttParentId);
  assert.equal(cleared.length, 1);
  assert.equal(f.values.get(cleared[0]).has(KEYS.parent), false);
});

test("isAncestor and depthOf terminate on a self-parent", () => {
  const { A } = build([["A"]]);
  A._zttParentId = A._zttId;
  assert.equal(model.isAncestor(A, A), false);
  assert.equal(model.depthOf(A), 0);
  assert.equal(model.inCycle(A), true);
});

test("a recursive collapse folds every parent below", () => {
  const { A, B, C } = build([["A"], ["B", "A"], ["C", "B"], ["D", "C"], ["E", "A"]]);
  model.toggleCollapsed(A, true);
  assert.deepEqual([A, B, C].map(t => t._zttCollapsed), [true, true, true]);
  assert.deepEqual(gBrowser.tabs.filter(t => ["D", "E"].includes(t.label)).map(t => !!t._zttCollapsed), [false, false]);
  model.toggleCollapsed(A, true);
  assert.deepEqual([A, B, C].map(t => t._zttCollapsed), [false, false, false]);
});

test("repairOrder stops when the same move keeps coming back", () => {
  const { A, B } = build([["A"], ["X"], ["B"]]);
  A._zttParentId = B._zttId;
  B._zttParentId = A._zttId;
  let moves = 0;
  const move = gBrowser.moveTabAfter;
  gBrowser.moveTabAfter = (t, target) => (moves++, move(t, target));
  const warn = console.warn;
  console.warn = () => assert.fail("gave up");
  try {
    model.repairOrder();
  } finally {
    gBrowser.moveTabAfter = move;
    console.warn = warn;
  }
  assert.ok(moves < 5, `${moves} moves`);
});

test("a pinned tab in a collapsed pinned section is laid out like one in a collapsed folder", () => {
  const pinned = f.list("pinned");
  const pins = f.element({ tagName: "zen-workspace-collapsible-pins", isZenFolder: true, collapsed: true });
  const P = f.tab("P", pinned, { pinned: true, group: pins });
  const C = f.tab("C", pinned, { pinned: true, group: pins });
  model.load(P);
  model.load(C);
  model.setParent(C, P);
  C.selected = true;
  const node = model.sidebarNodes().find(n => n.element === C);
  assert.equal(node.inCollapsedFolder, true);
  assert.equal(node.folderActive, true);
  assert.equal(model.sidebarNodes().find(n => n.element === P).folderActive, false);
});

test("moving into a pinned list while pins are collapsed never adds the tab to the pins element", () => {
  const w = f.space("w");
  let added = 0;
  const pins = f.element({ tagName: "zen-workspace-collapsible-pins", isZenFolder: true, collapsed: true, addTabs() { added++; } });
  const ref = f.tab("R", w.pinned, { pinned: true, group: pins });
  const t = f.tab("T", w.normal);
  assert.equal(model.moveIntoList(t, ref), true);
  assert.equal(added, 0);
});

test("sidebarNodes lists folders and split groups where they sit", () => {
  const list = f.space("w").normal;
  const A = f.tab("A", list);
  const F = f.folder("F", list);
  const X = f.tab("X", F.container);
  const S = f.split("S", list);
  f.tab("Y", S);
  f.tab("Z", S);
  for (const t of [A, X]) model.load(t);
  assert.deepEqual(model.sidebarNodes().map(n => n.key), [A._zttId, "f:F", X._zttId, "s:S"]);
  assert.equal(model.sidebarNodes().find(n => n.element === X).parent, "f:F");
});

test("a tab torn off into a new window forgets a parent left behind", () => {
  const C = f.tab("C", normal, { stored: { [KEYS.id]: "c", [KEYS.parent]: "p", [KEYS.collapsed]: "true" } });
  const D = f.tab("D", normal, { stored: { [KEYS.id]: "d", [KEYS.parent]: "gone" } });
  model.load(C);
  model.load(D);
  f.windows.push({ closed: false, gZenWorkspaces: { allStoredTabs: [{ _zttId: "p" }] } });
  model.dropForeignTrees();
  assert.equal(C._zttParentId, null);
  assert.equal(C._zttCollapsed, false);
  assert.equal(f.values.get(C).has(KEYS.parent), false);
  assert.equal(D._zttParentId, "gone");
});

test("the model's own moves leave no move counted afterwards", () => {
  const { A, B, X } = build([["A"], ["B", "A"], ["X"]]);
  assert.equal(model.moveSubtree(X, A, B), true);
  assert.equal(model.internalMoves, 0);
});

test("moveSubtree refuses cycles and other lists", () => {
  const { A, B, X } = build([["A"], ["B", "A"], ["X"]]);
  const other = f.tab("O", f.list("other"));
  model.load(other);
  assert.equal(model.moveSubtree(A, B, B), false);
  assert.equal(model.moveSubtree(A, A, null), false);
  assert.equal(model.moveSubtree(X, null, other), false);
  assert.equal(model.moveSubtree(X, other, null), false);
  assert.equal(X._zttParentId, null);
});

test("childrenOf only counts children in the parent's list", () => {
  const { A, B } = build([["A"], ["B", "A"]]);
  const K = f.tab("K", f.list("pinned"));
  model.load(K);
  K._zttParentId = A._zttId;
  assert.deepEqual(model.childrenOf(A), [B]);
});

test("a tab inside a split view wrapper is not eligible", () => {
  const t = f.tab("t", normal);
  t.splitview = {};
  assert.equal(model.isEligible(t), false);
});

test("a parent that has not been placed yet is not live", () => {
  const { A, B } = build([["A"], ["B", "A"]]);
  A._zttPending = true;
  assert.equal(model.liveParent(B, model.idMap()), null);
  assert.equal(model.isPlaced(A), false);
});
