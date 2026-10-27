import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakes } from "./fakes.mjs";
import { TreeModel, KEYS } from "../js/model.mjs";
import { Behaviour } from "../js/behaviour.mjs";

let f, model, behaviour, normal;
const tick = () => new Promise(resolve => setTimeout(resolve));
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
const closing = tab => {
  tab.closing = true;
  return tab;
};

beforeEach(() => {
  f = installFakes();
  model = new TreeModel();
  behaviour = new Behaviour({ model, refresh() {}, scheduleRefresh() {} });
  normal = f.list("normal");
});

test("closing an expanded parent promotes its children with a promotion record", () => {
  const { GP, P, C1, C2 } = build([["GP"], ["P", "GP"], ["C1", "P"], ["C2", "P"]]);
  behaviour.onTabClose(closing(P), {});
  for (const child of [C1, C2]) {
    assert.equal(child._zttParentId, GP._zttId);
    assert.deepEqual(child._zttPromotions.at(-1), { from: "p", to: "gp" });
  }
});

test("closing a collapsed parent closes its descendants tagged in order", async () => {
  const { P, C1, C2 } = build([["P"], ["C1", "P"], ["C2", "C1"], ["X"]]);
  model.setCollapsed(P, true);
  f.store.writes.length = 0;
  behaviour.onTabClose(closing(P), {});
  await tick();
  assert.deepEqual(f.store.removed, [C1, C2]);
  assert.deepEqual(JSON.parse(f.values.get(C1).get(KEYS.closedWith)), { root: "p", order: 0 });
  assert.deepEqual(JSON.parse(f.values.get(C2).get(KEYS.closedWith)), { root: "p", order: 1 });
  assert.equal(f.store.writes.filter(([t]) => t === P).length, 0);
});

test("a parent moved to another window leaves its children behind, even when collapsed", async () => {
  const { GP, P, C1 } = build([["GP"], ["P", "GP"], ["C1", "P"]]);
  model.setCollapsed(P, true);
  behaviour.onTabClose(closing(P), { adoptedBy: {} });
  await tick();
  assert.equal(f.store.removed, undefined);
  assert.equal(C1._zttParentId, GP._zttId);
  assert.deepEqual(C1._zttPromotions, []);
});

test("restoring a parent reclaims children whose last promotion came from it", () => {
  const { A, C } = build([["A"], ["C"]]);
  C._zttPromotions = [{ from: "p", to: null }];
  const P = f.tab("P", normal, { stored: { [KEYS.id]: "p" } });
  behaviour.onTabRestoring(P);
  assert.equal(C._zttParentId, "p");
  assert.deepEqual(C._zttPromotions, []);
  assert.equal(f.order(), "A P C");
  void A;
});

test("a promoted child that was moved since is not reclaimed", () => {
  const { X, C } = build([["X"], ["C", "X"]]);
  C._zttPromotions = [{ from: "p", to: null }];
  const P = f.tab("P", normal, { stored: { [KEYS.id]: "p" } });
  behaviour.onTabRestoring(P);
  assert.equal(C._zttParentId, X._zttId);
});

test("a duplicated tab becomes a sibling with a new id below the original's subtree", () => {
  const { A, O, K } = build([["A"], ["O", "A"], ["K", "O"], ["Z"]]);
  const D = f.tab("D", normal, { stored: { [KEYS.id]: "o", [KEYS.parent]: "a" } });
  behaviour.onTabRestoring(D);
  assert.notEqual(D._zttId, "o");
  assert.equal(D._zttParentId, A._zttId);
  assert.equal(f.order(), "A O K D Z");
  assert.equal(O._zttId, "o");
  void K;
});

test("restoring one tab of a tree closed as a whole reopens the rest in order under the root", () => {
  build([["Y"]]);
  const R = f.tab("R", normal, { stored: { [KEYS.id]: "r", [KEYS.collapsed]: "true" } });
  f.store.closed = [
    { closedId: 2, label: "C2", list: normal, state: { extData: { [KEYS.id]: "c2", [KEYS.parent]: "c1", [KEYS.closedWith]: '{"root":"r","order":1}' } } },
    { closedId: 1, label: "C1", list: normal, state: { extData: { [KEYS.id]: "c1", [KEYS.parent]: "r", [KEYS.closedWith]: '{"root":"r","order":0}' } } },
    { closedId: 3, label: "U", list: normal, state: { extData: { [KEYS.id]: "u" } } },
  ];
  f.order();
  behaviour.onTabRestoring(R);
  assert.equal(f.order(), "Y R C1 C2");
  assert.deepEqual(f.store.closed.map(c => c.label), ["U"]);
  assert.equal(gBrowser.selectedTab, R);
  assert.equal(SessionStore.getCustomTabValue(gBrowser.tabs.find(t => t.label === "C1"), KEYS.closedWith), "");
});

test("tabs closing as part of a whole tree keep their structure for undo", async () => {
  const { P, Q, R } = build([["P"], ["Q", "P"], ["R", "Q"]]);
  model.setCollapsed(P, true);
  behaviour.onTabClose(closing(P), {});
  await tick();
  R.closing = false;
  R.isConnected = true;
  behaviour.onTabClose(closing(Q), {});
  assert.equal(R._zttParentId, Q._zttId);
  assert.deepEqual(R._zttPromotions, []);
});

test("restoring a tab that would close a loop of parents breaks the loop", () => {
  const { X } = build([["X"]]);
  const C = f.tab("C", normal, { stored: { [KEYS.id]: "c", [KEYS.parent]: "a" } });
  model.load(C);
  model.nestUnder(X, C);
  const A = f.tab("A", normal, { stored: { [KEYS.id]: "a", [KEYS.parent]: "x" } });
  behaviour.onTabRestoring(A);
  for (const t of [X, A, C]) {
    assert.equal(model.inCycle(t), false, t.label);
  }
});

test("a collapsed tree too big for Recently Closed moves its children up instead", async () => {
  f.prefs.set("browser.sessionstore.max_tabs_undo", 3);
  const { P, C1, C2, C3 } = build([["P"], ["C1", "P"], ["C2", "P"], ["C3", "P"]]);
  model.setCollapsed(P, true);
  behaviour.onTabClose(closing(P), {});
  await tick();
  assert.equal(f.store.removed, undefined);
  for (const child of [C1, C2, C3]) {
    assert.equal(child._zttParentId, null);
    assert.deepEqual(child._zttPromotions.at(-1), { from: "p", to: null });
  }
});

test("a collapsed tree that fits Recently Closed still closes as a whole", async () => {
  f.prefs.set("browser.sessionstore.max_tabs_undo", 4);
  const { P, C1, C2, C3 } = build([["P"], ["C1", "P"], ["C2", "P"], ["C3", "P"]]);
  model.setCollapsed(P, true);
  behaviour.onTabClose(closing(P), {});
  await tick();
  assert.deepEqual(f.store.removed, [C1, C2, C3]);
});

test("a descendant that survives the cascade loses its closed-with tag", async () => {
  const { P, C1, C2 } = build([["P"], ["C1", "P"], ["C2", "P"]]);
  model.setCollapsed(P, true);
  f.store.keepOpen = new Set([C2]);
  behaviour.onTabClose(closing(P), {});
  await tick();
  assert.notEqual(SessionStore.getCustomTabValue(C1, KEYS.closedWith), "");
  assert.equal(SessionStore.getCustomTabValue(C2, KEYS.closedWith), "");
});

test("members restored without their root lose their closed-with tags", () => {
  const tag = order => ({ [KEYS.closedWith]: JSON.stringify({ root: "r", order }) });
  const M1 = f.tab("M1", normal, { stored: { [KEYS.id]: "m1", ...tag(0) } });
  const M2 = f.tab("M2", normal, { stored: { [KEYS.id]: "m2", ...tag(1) } });
  model.load(M2);
  behaviour.onTabRestoring(M1);
  assert.equal(SessionStore.getCustomTabValue(M1, KEYS.closedWith), "");
  assert.equal(SessionStore.getCustomTabValue(M2, KEYS.closedWith), "");
});

test("children promoted from a tab whose parent is closed are reclaimed when it comes back", () => {
  const T = f.tab("T", normal, { stored: { [KEYS.id]: "t", [KEYS.parent]: "p" } });
  model.load(T);
  const C = f.tab("C", normal, { stored: { [KEYS.id]: "c" } });
  model.load(C);
  model.setParent(C, T);
  behaviour.onTabClose(closing(T), {});
  T.isConnected = false;
  assert.equal(C._zttParentId, null);
  const back = f.tab("T", normal, { stored: { [KEYS.id]: "t", [KEYS.parent]: "p" } });
  behaviour.onTabRestoring(back);
  assert.equal(C._zttParentId, "t");
});

const otherWindow = twins => ({
  closed: false,
  document: { getElementById: id => twins[id] ?? null, documentElement: { hasAttribute: () => false } },
  gZenWorkspaces: { privateWindowOrDisabled: false, allStoredTabs: [] },
});

test("a close echoed from another synced window moves children up", async () => {
  f.prefs.set("zen.window-sync.enabled", true);
  f.windows.push(otherWindow({ "sync-p": { closing: true } }));
  const { P, C } = build([["P"], ["C", "P"]]);
  P.id = "sync-p";
  model.setCollapsed(P, true);
  behaviour.onTabClose(closing(P), {});
  await tick();
  assert.equal(f.store.removed, undefined);
  assert.equal(C._zttParentId, null);
});

test("a close made in this window still cascades with window sync", async () => {
  f.prefs.set("zen.window-sync.enabled", true);
  f.windows.push(otherWindow({ "sync-p": { closing: false } }));
  const { P, C } = build([["P"], ["C", "P"]]);
  P.id = "sync-p";
  model.setCollapsed(P, true);
  behaviour.onTabClose(closing(P), {});
  await tick();
  assert.deepEqual(f.store.removed, [C]);
});

test("without window sync a collapsed close cascades whatever other windows hold", async () => {
  f.windows.push(otherWindow({}));
  const { P, C } = build([["P"], ["C", "P"]]);
  P.id = "sync-p";
  model.setCollapsed(P, true);
  behaviour.onTabClose(closing(P), {});
  await tick();
  assert.deepEqual(f.store.removed, [C]);
});

const withSuccessors = () => {
  gBrowser.setSuccessor = (t, successor) => (t.successor = successor);
  gBrowser._findTabToBlurTo = (t, exclude) => gBrowser.tabs.find(x => x !== t && !exclude.includes(x));
};

test("a selected collapsed parent's successor skips its hidden tree", () => {
  withSuccessors();
  const { P, X } = build([["P"], ["C", "P"], ["D", "C"], ["X"]]);
  model.setCollapsed(P, true);
  gBrowser.selectedTab = P;
  behaviour.updateSuccessor();
  assert.equal(P.successor, X);
});

test("expanding gives back the successor the tab had before", () => {
  withSuccessors();
  const { P, Y } = build([["P"], ["C", "P"], ["X"], ["Y"]]);
  P.successor = Y;
  model.setCollapsed(P, true);
  gBrowser.selectedTab = P;
  behaviour.updateSuccessor();
  assert.notEqual(P.successor, Y);
  model.setCollapsed(P, false);
  behaviour.updateSuccessor();
  assert.equal(P.successor, Y);
});

test("a successor set by someone else is left alone", () => {
  withSuccessors();
  const { P, Y } = build([["P"], ["C", "P"], ["X"], ["Y"]]);
  model.setCollapsed(P, true);
  gBrowser.selectedTab = P;
  behaviour.updateSuccessor();
  P.successor = Y;
  gBrowser.selectedTab = Y;
  behaviour.updateSuccessor();
  assert.equal(P.successor, Y);
});

test("promotions from two closed ancestors are undone in reverse order", () => {
  const { GP, P, C } = build([["GP"], ["P", "GP"], ["C", "P"]]);
  behaviour.onTabClose(closing(P), {});
  P.isConnected = false;
  behaviour.onTabClose(closing(GP), {});
  GP.isConnected = false;
  assert.equal(C._zttParentId, null);
  behaviour.onTabRestoring(f.tab("GP", normal, { stored: { [KEYS.id]: "gp" } }));
  assert.equal(C._zttParentId, "gp");
  behaviour.onTabRestoring(f.tab("P", normal, { stored: { [KEYS.id]: "p", [KEYS.parent]: "gp" } }));
  assert.equal(C._zttParentId, "p");
  assert.deepEqual(C._zttPromotions, []);
});

test("restoring one member of a tree closed as a whole brings back its root and the rest", () => {
  build([["Y"]]);
  const C1 = f.tab("C1", normal, { stored: { [KEYS.id]: "c1", [KEYS.parent]: "r", [KEYS.closedWith]: '{"root":"r","order":0}' } });
  f.store.closed = [
    { closedId: 2, label: "C2", list: normal, state: { extData: { [KEYS.id]: "c2", [KEYS.parent]: "c1", [KEYS.closedWith]: '{"root":"r","order":1}' } } },
    { closedId: 1, label: "R", list: normal, state: { extData: { [KEYS.id]: "r", [KEYS.collapsed]: "true" } } },
  ];
  behaviour.onTabRestoring(C1);
  assert.equal(f.order(), "Y R C1 C2");
  assert.deepEqual(f.store.closed, []);
  assert.equal(gBrowser.selectedTab.label, "R");
});

afterEach(() => assert.deepEqual(f.violations, [], "a move crossed lists"));
