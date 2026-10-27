import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakes } from "./fakes.mjs";
import { TreeModel, KEYS } from "../js/model.mjs";
import { Behaviour } from "../js/behaviour.mjs";
import { Input } from "../js/input.mjs";

let f, model, trees, normal;
const build = spec => {
  const made = {};
  for (const [label] of spec) {
    made[label] = f.tab(label, normal, { stored: { [KEYS.id]: label.toLowerCase() } });
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
  trees = { model, refresh() {}, scheduleRefresh() {} };
  normal = f.list("normal");
});

test("a tab moved into a tree takes the parent implied by its position and brings its subtree", () => {
  const { A, B, X } = build([["A"], ["B", "A"], ["C", "A"], ["X"], ["Y", "X"]]);
  f.externalMove(X, B, true);
  new Behaviour(trees).onTabMove(X);
  assert.equal(X._zttParentId, A._zttId);
  assert.equal(f.order(), "A B X Y C");
});

test("our own moves are not treated as moves by others", () => {
  const { B, X } = build([["A"], ["B", "A"], ["C", "A"], ["X"]]);
  f.externalMove(X, B, true);
  model.internalMoves++;
  new Behaviour(trees).onTabMove(X);
  assert.equal(X._zttParentId, null);
});

test("resolveDrop at depth prev+1 inserts after prev as its child", () => {
  const { B, C } = build([["A"], ["B", "A"], ["C"]]);
  const drop = new Input(trees).resolveDrop({ tab: C, subtree: new Set() }, { prev: "b", depth: 2 });
  assert.equal(drop.parent, B);
  assert.equal(drop.after, B);
});

test("resolveDrop at prev's depth inserts after prev's whole block", () => {
  const { A, K, C } = build([["A"], ["B", "A"], ["K", "B"], ["C"]]);
  const drop = new Input(trees).resolveDrop({ tab: C, subtree: new Set() }, { prev: "b", depth: 1 });
  assert.equal(drop.parent, A);
  assert.equal(drop.after, K);
});

test("resolveDrop excludes the dragged subtree from the anchor", () => {
  const { A, B, K } = build([["A"], ["B", "A"], ["K", "B"]]);
  const drop = new Input(trees).resolveDrop({ tab: K, subtree: new Set() }, { prev: "b", depth: 1 });
  assert.equal(drop.parent, A);
  assert.equal(drop.after, B);
});

test("resolveDrop at the top level of an empty gap has no parent", () => {
  const { C } = build([["A"], ["C"]]);
  const drop = new Input(trees).resolveDrop({ tab: C, subtree: new Set() }, { prev: null, depth: 0 });
  assert.deepEqual(drop, { parent: null, after: null });
});

test("onTabMove ignores tabs whose neighbours did not change", () => {
  const { A, C } = build([["A"], ["C", "A"]]);
  model.recordOrder();
  const behaviour = new Behaviour(trees);
  behaviour.onTabMove(A);
  behaviour.onTabMove(C);
  assert.equal(C._zttParentId, A._zttId);
});

test("dropping onto another list's rows moves the stack there, nested as shown", () => {
  const w = f.space("w");
  const make = (label, listNode, options = {}) => {
    const t = f.tab(label, listNode, { ...options, stored: { [KEYS.id]: label.toLowerCase() } });
    t.setAttribute("zen-workspace-id", "w");
    model.load(t);
    return t;
  };
  const P = make("P", w.pinned, { pinned: true });
  make("Q", w.pinned, { pinned: true });
  const T = make("T", w.normal);
  const C = make("C", w.normal);
  model.setParent(C, T);
  const input = new Input(trees);
  input.applyDrop({ tab: T, subtree: new Set([C]) }, { prev: "p", next: "q", depth: 1 });
  assert.equal(f.order(w.pinned), "P T C Q");
  assert.equal(T._zttParentId, P._zttId);
  assert.equal(C._zttParentId, T._zttId);
  assert.ok(T.pinned && C.pinned);
});

test("dropping within the same list still brings the subtree", () => {
  const { A, X, Y } = build([["A"], ["B", "A"], ["X"], ["Y", "X"]]);
  new Input(trees).applyDrop({ tab: X, subtree: new Set([Y]) }, { prev: "b", next: null, depth: 1 });
  assert.equal(f.order(), "A B X Y");
  assert.equal(X._zttParentId, A._zttId);
});

const step = (tab, target, after) => {
  model.recordOrder();
  f.externalMove(tab, target, after);
  new Behaviour(trees).onTabMove(tab);
};

test("Move Tab Forward on a parent steps past the next visible row", () => {
  const { P, C1, S } = build([["P"], ["C1", "P"], ["S"]]);
  step(P, C1, true);
  assert.equal(f.order(), "S P C1");
  assert.equal(P._zttParentId, null);
  assert.equal(C1._zttParentId, P._zttId);
  void S;
});

test("Move Tab Forward on the last parent leaves it where it was", () => {
  const { P, C1 } = build([["A"], ["P"], ["C1", "P"]]);
  step(P, C1, true);
  assert.equal(f.order(), "A P C1");
});

test("Move Tab Forward past a collapsed sibling steps over its whole tree", () => {
  const { P, C1, C2 } = build([["P"], ["C1", "P"], ["C2", "P"], ["G", "C2"], ["X"]]);
  model.setCollapsed(C2, true);
  step(C1, C2, true);
  assert.equal(f.order(), "P C2 G C1 X");
  assert.equal(C1._zttParentId, P._zttId);
  assert.equal(C2._zttCollapsed, true);
});

test("Move Tab Backward past a collapsed sibling lands before it", () => {
  const { P, C2, H, C3 } = build([["P"], ["C2", "P"], ["H", "C2"], ["C3", "P"]]);
  model.setCollapsed(C2, true);
  step(C3, H, false);
  assert.equal(f.order(), "P C3 C2 H");
  assert.equal(C3._zttParentId, P._zttId);
  assert.equal(C2._zttCollapsed, true);
});

test("Move Tab Backward on a revealed tab steps it above its collapsed tree", () => {
  const { R, A, B } = build([["R"], ["A", "R"], ["B", "R"]]);
  model.setCollapsed(R, true);
  B.selected = true;
  step(B, A, false);
  assert.equal(f.order(), "B R A");
  assert.equal(B._zttParentId, null);
  assert.equal(R._zttCollapsed, true);
});

test("Move Tab Forward on a revealed tab steps it past the next visible row", () => {
  const { R, A, B } = build([["R"], ["B", "R"], ["A", "R"], ["X"]]);
  model.setCollapsed(R, true);
  B.selected = true;
  step(B, A, true);
  assert.equal(f.order(), "R A X B");
  assert.equal(B._zttParentId, null);
  assert.equal(R._zttCollapsed, true);
});

test("a hidden tab reordered inside its collapsed tree stays in it", () => {
  const { R, A, B } = build([["R"], ["A", "R"], ["B", "R"]]);
  model.setCollapsed(R, true);
  step(B, A, false);
  assert.equal(f.order(), "R B A");
  assert.equal(B._zttParentId, R._zttId);
});

test("a tab Zen moves from further down into a collapsed tree lands below that tree", () => {
  const { Q, X } = build([["Q"], ["Q1", "Q"], ["A"], ["B"], ["X"]]);
  model.setCollapsed(Q, true);
  step(X, Q, true);
  assert.equal(f.order(), "Q Q1 X A B");
  assert.equal(X._zttParentId, null);
  assert.equal(Q._zttCollapsed, true);
});

test("a tab moved between a collapsed parent and its hidden children lands beside the tree", () => {
  const { C, X } = build([["C"], ["K", "C"], ["X"]]);
  model.setCollapsed(C, true);
  step(X, C, true);
  assert.equal(f.order(), "X C K");
  assert.equal(X._zttParentId, null);
  assert.equal(C._zttCollapsed, true);
});

test("a tab moved into an expanded tree joins it", () => {
  const { C, X } = build([["C"], ["K", "C"], ["X"]]);
  step(X, C, true);
  assert.equal(f.order(), "C X K");
  assert.equal(X._zttParentId, C._zttId);
});

test("resolveDrop at depth prev+1 makes the first child of a parent with children", () => {
  const { A, B, C, K } = build([["A"], ["B", "A"], ["K", "B"], ["C"]]);
  new Input(trees).applyDrop({ tab: C, subtree: new Set() }, { prev: "b", next: "k", depth: 2 });
  assert.equal(f.order(), "A B C K");
  assert.equal(C._zttParentId, B._zttId);
  void A;
  void K;
});

test("a drop below a revealed row uses the depth drawn on screen", () => {
  const { R, B } = build([["R"], ["A", "R"], ["B", "A"], ["X"]]);
  model.setCollapsed(R, true);
  trees.renderer = { entryOf: key => (key === "b" ? { depth: 1, chain: ["r"] } : null) };
  const input = new Input(trees);
  const X = f.tabs.find(t => t.label === "X");
  assert.equal(input.resolveDrop({ tab: X, subtree: new Set() }, { prev: "b", depth: 2 }).parent, B);
  assert.equal(input.resolveDrop({ tab: X, subtree: new Set() }, { prev: "b", depth: 1 }).parent, R);
  assert.equal(input.resolveDrop({ tab: X, subtree: new Set() }, { prev: "b", depth: 0 }).parent, null);
});

test("a drop after a folder lands right after the folder at the top level", () => {
  const P1 = f.tab("P1", normal, { stored: { [KEYS.id]: "p1" } });
  const F = f.folder("F", normal);
  f.tab("X", F.container);
  const P2 = f.tab("P2", normal, { stored: { [KEYS.id]: "p2" } });
  const Y = f.tab("Y", normal, { stored: { [KEYS.id]: "y" } });
  const K = f.tab("K", normal, { stored: { [KEYS.id]: "k" } });
  for (const t of [P1, P2, Y, K]) model.load(t);
  model.setParent(Y, P1);
  model.setParent(K, Y);
  new Input(trees).applyDrop(
    { tab: Y, subtree: new Set([K]), rowElements: new Map([["f:F", F]]) },
    { prev: "f:F", next: "p2", depth: 0 }
  );
  assert.deepEqual([...normal.children].map(el => el.label ?? el.id), ["P1", "F", "Y", "K", "P2"]);
  assert.equal(Y._zttParentId, null);
  assert.equal(K._zttParentId, Y._zttId);
});

test("stepping past a collapsed tab without children follows the positional rule", () => {
  const { C1, C2 } = build([["P"], ["C1", "P"], ["C2", "P"]]);
  model.setCollapsed(C2, true);
  step(C1, C2, true);
  assert.equal(f.order(), "P C2 C1");
  assert.equal(C1._zttParentId, null);
});

test("a dropped stack skips descendants that closed meanwhile", () => {
  const { A, X, Y } = build([["A"], ["B", "A"], ["X"], ["Y", "X"]]);
  Y.isConnected = false;
  const moved = [];
  const move = gBrowser.moveTabAfter;
  gBrowser.moveTabAfter = (t, target) => (moved.push(t.label), move(t, target));
  new Input(trees).applyDrop({ tab: X, subtree: new Set([Y]) }, { prev: "b", next: null, depth: 1 });
  gBrowser.moveTabAfter = move;
  assert.equal(X._zttParentId, A._zttId);
  assert.ok(!moved.includes("Y"), moved.join(" "));
});

afterEach(() => assert.deepEqual(f.violations, [], "a move crossed lists"));
