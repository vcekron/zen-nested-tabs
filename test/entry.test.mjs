import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakes } from "./fakes.mjs";

let f, ZenTabTrees, listeners, observers, progress, unload;

const target = () => ({
  addEventListener: (type, handler, capture = false) => listeners.push({ type, handler, capture: !!capture }),
  removeEventListener: (type, handler, capture = false) => {
    const i = listeners.findIndex(l => l.type === type && l.handler === handler && l.capture === !!capture);
    assert.notEqual(i, -1, `removing ${type} that was never added`);
    listeners.splice(i, 1);
  },
});

beforeEach(async () => {
  f = installFakes();
  listeners = [];
  observers = [];
  progress = [];
  unload = null;
  Object.assign(globalThis, target());
  globalThis.document = {
    documentElement: { style: { setProperty() {} }, removeAttribute() {} },
    querySelectorAll: () => [],
  };
  globalThis.gNavToolbox = {};
  globalThis.Ci = { nsIWebProgressListener: { STATE_STOP: 1, STATE_IS_NETWORK: 2 } };
  globalThis.MutationObserver = class {
    constructor() { this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  };
  globalThis.delayedStartupPromise = Promise.resolve();
  globalThis.addUnloadListener = callback => (unload = callback);
  gZenWorkspaces.promiseInitialized = Promise.resolve();
  SessionStore.promiseAllWindowsRestored = Promise.resolve();
  gBrowser.tabContainer = target();
  gBrowser.addTabsProgressListener = l => progress.push(l);
  gBrowser.removeTabsProgressListener = l => progress.splice(progress.indexOf(l), 1);
  ({ ZenTabTrees } = await import("../js/zen-tab-trees.uc.mjs"));
});

const started = async () => {
  const trees = new ZenTabTrees();
  trees.refresh = () => {};
  window.gZenTabTrees = trees;
  await trees.init();
  return trees;
};

test("a dragstart on a tree control never starts a tree drag", () => {
  const trees = new ZenTabTrees();
  let drags = 0;
  trees.input = { onPointer: () => true, onDragStart: () => drags++ };
  trees.handleEvent({ type: "dragstart" });
  assert.equal(drags, 0);
  trees.input.onPointer = () => false;
  trees.handleEvent({ type: "dragstart" });
  assert.equal(drags, 1);
});

test("init listens once and teardown removes every listener, observer and progress listener", async () => {
  const trees = await started();
  assert.ok(listeners.length > 20);
  assert.ok(observers.every(o => o.connected));
  assert.equal(progress.length, 1);
  trees.teardown();
  assert.deepEqual(listeners, []);
  assert.ok(observers.every(o => !o.connected));
  assert.deepEqual(progress, []);
  assert.equal(window.gZenTabTrees, undefined);
});

test("Sine's unload hook tears the tree down", async () => {
  await started();
  assert.equal(typeof unload, "function");
  unload();
  assert.deepEqual(listeners, []);
});

test("the tree clears what it drew when torn down", async () => {
  const trees = await started();
  const cleared = [];
  trees.renderer.clear = t => cleared.push(t);
  const T = f.tab("T", f.space("w").normal);
  trees.teardown();
  assert.deepEqual(cleared, [T]);
});

test("a mouseup anywhere in the window ends a pending tree drag; on the tab strip it is still a pointer event", () => {
  const trees = new ZenTabTrees();
  const calls = [];
  trees.input = { onMouseUp: () => calls.push("up"), onPointer: () => calls.push("pointer") };
  trees.handleEvent({ type: "mouseup", currentTarget: window });
  trees.handleEvent({ type: "mouseup", currentTarget: gBrowser.tabContainer });
  assert.deepEqual(calls, ["up", "pointer"]);
});
