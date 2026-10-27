import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakes } from "./fakes.mjs";
import { TreeModel, KEYS } from "../js/model.mjs";
import { Behaviour } from "../js/behaviour.mjs";

let f, model, behaviour, w;
const tick = () => new Promise(resolve => setTimeout(resolve));
const make = (label, listNode, options = {}) => {
  const t = f.tab(label, listNode, { ...options, stored: { [KEYS.id]: label.toLowerCase() } });
  t.setAttribute("zen-workspace-id", "w");
  model.load(t);
  return t;
};
const open = async (label, listNode, opener, after = null) => {
  const t = f.tab(label, listNode);
  t.setAttribute("zen-workspace-id", "w");
  t.openerTab = opener;
  if (after) f.externalMove(t, after, true);
  behaviour.onTabOpen(t);
  await tick();
  return t;
};

beforeEach(() => {
  f = installFakes();
  model = new TreeModel();
  behaviour = new Behaviour({ model, refresh() {}, scheduleRefresh() {} });
  w = f.space("w");
});

test("a link from a pinned tab is pinned into the opener's list and nested last", async () => {
  const P = make("P", w.pinned, { pinned: true });
  const K = make("K", w.pinned, { pinned: true });
  model.setParent(K, P);
  make("Q", w.pinned, { pinned: true });
  make("X", w.normal);
  const N = await open("N", w.normal, P);
  assert.equal(N.pinned, true);
  assert.equal(N.parentNode, w.pinned);
  assert.equal(N._zttParentId, P._zttId);
  assert.equal(f.order(w.pinned), "P K N Q");
  assert.equal(N._zttList, w.pinned);
});

test("a link from a pinned tab in a folder lands in that folder, nested", async () => {
  const F = f.folder("F");
  const P = make("P", F.container, { pinned: true, group: F });
  make("X", w.normal);
  const N = await open("N", w.normal, P);
  assert.equal(N.parentNode, F.container);
  assert.equal(N.group, F);
  assert.equal(N._zttParentId, P._zttId);
});

test("a link from an Essential opens top-level", async () => {
  const E = make("E", f.list("essentials"), { attrs: { "zen-essential": "true" } });
  const A = make("A", w.normal);
  const B = make("B", w.normal);
  model.setParent(B, A);
  make("C", w.normal);
  model.setParent(gBrowser.tabs.find(t => t.label === "C"), A);
  const N = await open("N", w.normal, E, B);
  assert.equal(N._zttParentId, null);
  assert.equal(N.parentNode, w.normal);
  assert.equal(f.order(w.normal), "A B N C");
});

test("a link from a split-view tab opens top-level", async () => {
  const split = f.element({ attrs: { "split-view-group": "true" } });
  const S = make("S", f.list("split"), { group: split });
  const A = make("A", w.normal);
  const B = make("B", w.normal);
  model.setParent(B, A);
  const C = make("C", w.normal);
  model.setParent(C, A);
  const N = await open("N", w.normal, S, B);
  assert.equal(N._zttParentId, null);
  assert.equal(N.parentNode, w.normal);
  assert.equal(f.order(w.normal), "A B N C");
});

test("an expanded Glance tab nests under its owner", () => {
  const P = make("P", w.normal);
  make("K", w.normal);
  model.setParent(gBrowser.tabs.find(t => t.label === "K"), P);
  const G = make("G", w.normal);
  G.owner = P;
  f.externalMove(G, P, true);
  behaviour.onGlanceOpened(G);
  assert.equal(G._zttParentId, P._zttId);
  assert.equal(f.order(w.normal), "P K G");
});

test("a tab that joins a split view leaves its tree and its children move up", () => {
  const A = make("A", w.normal);
  const T = make("T", w.normal);
  const C = make("C", w.normal);
  model.setParent(T, A);
  model.setParent(C, T);
  T.group = f.element({ attrs: { "split-view-group": "true" } });
  T.parentNode = f.list("split");
  model.applyListChanges();
  assert.equal(T._zttParentId, null);
  assert.equal(C._zttParentId, A._zttId);
});

test("a tab pinned by the opener rule before its link loads records its pinned URL and title once the page has loaded", async () => {
  const P = make("P", w.pinned, { pinned: true });
  make("X", w.normal);
  const N = await open("N", w.normal, P);
  assert.equal(f.store.pinnedStates, undefined);
  behaviour.onPageLoaded(N, "about:blank");
  assert.equal(f.store.pinnedStates, undefined);
  behaviour.onPageLoaded(N, "https://example.com/");
  await tick();
  assert.deepEqual(f.store.pinnedStates, [N]);
  assert.deepEqual(f.store.resets, [N]);
  behaviour.onPageLoaded(N, "https://example.com/other");
  assert.deepEqual(f.store.pinnedStates, [N]);
});

test("a tab that was already loaded when pinned keeps Zen's recorded URL", async () => {
  const P = make("P", w.pinned, { pinned: true });
  make("X", w.normal);
  const N = f.tab("N", w.normal);
  N.setAttribute("zen-workspace-id", "w");
  N.linkedBrowser.currentURI.spec = "https://example.com/";
  N.openerTab = P;
  behaviour.onTabOpen(N);
  await tick();
  behaviour.onPageLoaded(N, "https://example.com/next");
  assert.equal(f.store.pinnedStates, undefined);
});

test("a new tab that cannot join a tree is left alone", async () => {
  let scheduled = 0;
  behaviour = new Behaviour({ model, refresh() {}, scheduleRefresh: () => scheduled++ });
  const A = make("A", w.normal);
  const N = f.tab("N", w.normal, { attrs: { "zen-empty-tab": "true" } });
  N.openerTab = A;
  behaviour.onTabOpen(N);
  await tick();
  assert.equal(N._zttParentId, null);
  assert.equal(N._zttPending, false);
  assert.equal(scheduled, 1);
});

test("a tab whose tree values arrive from SessionStore is restored, not nested", async () => {
  const A = make("A", w.normal);
  const N = f.tab("N", w.normal);
  N.openerTab = make("O", w.normal);
  behaviour.onTabOpen(N);
  f.values.get(N).set(KEYS.id, "old").set(KEYS.parent, "a");
  await tick();
  assert.equal(N._zttId, "old");
  assert.equal(N._zttParentId, A._zttId);
});

test("a tab opened without an opener between a parent's children joins them", async () => {
  const A = make("A", w.normal);
  const B = make("B", w.normal);
  const C = make("C", w.normal);
  model.setParent(B, A);
  model.setParent(C, A);
  const N = await open("N", w.normal, null, B);
  assert.equal(N._zttParentId, A._zttId);
  assert.equal(f.order(w.normal), "A B N C");
});

test("a link whose opener's list it cannot reach takes the parent its position implies", async () => {
  const O = make("O", f.list("elsewhere"));
  const A = make("A", w.normal);
  const B = make("B", w.normal);
  make("C", w.normal);
  model.setParent(B, A);
  model.setParent(gBrowser.tabs.find(t => t.label === "C"), A);
  const N = await open("N", w.normal, O, B);
  assert.equal(N.parentNode, w.normal);
  assert.equal(N._zttParentId, A._zttId);
});

test("a Glance tab whose owner cannot hold a tree stays where it is", () => {
  const E = make("E", f.list("essentials"), { attrs: { "zen-essential": "true" } });
  const G = make("G", w.normal);
  G.owner = E;
  behaviour.onGlanceOpened(G);
  assert.equal(G._zttParentId, null);
});

test("a pinned tab moved into its opener's pinned folder keeps Zen's recorded URL", async () => {
  const F = f.folder("F");
  const P = make("P", F.container, { pinned: true, group: F });
  const N = f.tab("N", w.pinned, { pinned: true });
  N.setAttribute("zen-workspace-id", "w");
  N.openerTab = P;
  behaviour.onTabOpen(N);
  await tick();
  assert.equal(N.parentNode, F.container);
  assert.equal(N._zttRecordPinOnLoad, undefined);
});

afterEach(() => assert.deepEqual(f.violations, [], "a move crossed lists"));
