import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakes } from "./fakes.mjs";
import { TreeModel, KEYS } from "../js/model.mjs";
import { Input } from "../js/input.mjs";

const TAB_TYPE = "application/x-moz-tabbrowser-tab";
let f, model, trees, input, normal, expanded;

const style = () => {
  const props = new Map();
  return {
    props,
    setProperty: (k, v) => props.set(k, String(v)),
    removeProperty: k => props.delete(k),
    getPropertyValue: k => props.get(k) ?? "",
  };
};
const domify = el =>
  Object.assign(el, {
    style: style(),
    hidden: false,
    textContent: "",
    childNodes: [],
    toggleAttribute(a, force = !(a in this.attrs)) {
      if (force) this.attrs[a] = "";
      else delete this.attrs[a];
      return force;
    },
    replaceChildren(...nodes) { this.childNodes = nodes; },
    append(...nodes) { this.childNodes.push(...nodes); },
  });

const rows = [];
const make = (label, parent = null) => {
  const t = f.tab(label, normal, { stored: { [KEYS.id]: label.toLowerCase() } });
  t.setAttribute("zen-workspace-id", "w");
  domify(t);
  t.closest = sel => (sel === ".tabbrowser-tab" ? t : null);
  const index = rows.push(t) - 1;
  t.getBoundingClientRect = () => ({ top: index * 30, bottom: index * 30 + 30, left: 0, right: 200, height: 30 });
  model.load(t);
  if (parent) model.setParent(t, parent);
  return t;
};
const event = (type, target, { x = 10, y = 15, payload } = {}) => ({
  type,
  target,
  clientX: x,
  clientY: y,
  defaultPrevented: false,
  dataTransfer: { dropEffect: "", mozGetDataAt: (t, i) => (t === TAB_TYPE && i === 0 ? payload : null) },
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() {},
});

beforeEach(() => {
  f = installFakes();
  rows.length = 0;
  model = new TreeModel();
  trees = { model, refresh() {}, scheduleRefresh() {} };
  input = new Input(trees);
  normal = f.space("w").normal;
  expanded = "true";
  globalThis.Node = { TEXT_NODE: 3 };
  const root = domify(f.element());
  globalThis.document = {
    documentElement: root,
    body: domify(f.element()),
    createElementNS: () => domify(f.element()),
    querySelectorAll: () => [],
  };
  root.matches = () => false;
  globalThis.gNavToolbox = { getAttribute: a => (a === "zen-sidebar-expanded" ? expanded : null) };
  gBrowser.selectedTabs = [];
  gBrowser.tabContainer = {
    arrowScrollbox: {
      scrollbox: { scrollTop: 0 },
      getBoundingClientRect: () => ({ top: -1000, bottom: 1000 }),
      scrollByPixels(dy) { this.scrollbox.scrollTop += dy; },
    },
  };
});

afterEach(() => assert.deepEqual(f.violations, [], "a move crossed lists"));

test("a drag Zen never started lets the next foreign drop through", () => {
  const A = make("A");
  const B = make("B");
  input.onDragStart(event("dragstart", A));
  assert.ok(A.hasAttribute("ztt-drag-source"));
  const over = event("dragover", B, { payload: null });
  input.onDragOver(over);
  assert.equal(over.defaultPrevented, false);
  assert.equal(A.hasAttribute("ztt-drag-source"), false);
  const drop = event("drop", B, { payload: null });
  input.onDrop(drop);
  assert.equal(drop.defaultPrevented, false);
});

test("a drag whose tab has closed is dropped", () => {
  const A = make("A");
  const B = make("B");
  input.onDragStart(event("dragstart", A));
  A.isConnected = false;
  const over = event("dragover", B, { payload: A });
  input.onDragOver(over);
  assert.equal(over.defaultPrevented, false);
  assert.equal(A.hasAttribute("ztt-drag-source"), false);
});

test("a drag the tree started is handled", () => {
  const A = make("A");
  const B = make("B");
  input.onDragStart(event("dragstart", A));
  const over = event("dragover", B, { payload: A, y: 55 });
  input.onDragOver(over);
  assert.equal(over.defaultPrevented, true);
});

test("multiselect drags keep Zen's handling", () => {
  const A = make("A");
  const B = make("B");
  A.multiselected = true;
  gBrowser.selectedTabs = [A, B];
  input.onDragStart(event("dragstart", A));
  assert.equal(A.hasAttribute("ztt-drag-source"), false);
});

test("drags are ignored in the collapsed sidebar", () => {
  const A = make("A");
  expanded = "false";
  input.onDragStart(event("dragstart", A));
  assert.equal(A.hasAttribute("ztt-drag-source"), false);
});

test("dragged rows carry their own offset and lose it on dragend", () => {
  const A = make("A");
  const C = make("C", A);
  const B = make("B");
  input.onDragStart(event("dragstart", A, { y: 15 }));
  input.onDragOver(event("dragover", B, { payload: A, y: 75 }));
  for (const t of [A, C]) {
    assert.equal(t.style.getPropertyValue("--ztt-drag-dy"), "60px", t.label);
  }
  assert.equal(document.documentElement.style.getPropertyValue("--ztt-drag-dy"), "");
  input.onDragEnd();
  for (const t of [A, C]) {
    assert.equal(t.hasAttribute("ztt-drag-source"), false);
    assert.equal(t.style.getPropertyValue("--ztt-drag-dy"), "");
  }
  void B;
});

test("the offset follows the list as it scrolls", () => {
  const A = make("A");
  const B = make("B");
  input.onDragStart(event("dragstart", A, { y: 15 }));
  gBrowser.tabContainer.arrowScrollbox.scrollbox.scrollTop = 40;
  input.onDragOver(event("dragover", B, { payload: A, y: 25 }));
  assert.equal(A.style.getPropertyValue("--ztt-drag-dy"), "50px");
});

test("the drop parent is highlighted once per change", () => {
  const A = make("A");
  const B = make("B");
  const X = make("X");
  let marks = 0;
  const set = B.setAttribute;
  B.setAttribute = function (a, v) {
    if (a === "ztt-drop-parent") marks++;
    return set.call(this, a, v);
  };
  input.onDragStart(event("dragstart", X, { x: 10, y: 75 }));
  for (let i = 0; i < 2; i++) {
    input.onDragOver(event("dragover", B, { payload: X, x: 36, y: 55 }));
  }
  assert.ok(B.hasAttribute("ztt-drop-parent"));
  assert.equal(marks, 1);
  input.onDragOver(event("dragover", A, { payload: X, x: 10, y: 5 }));
  assert.equal(B.hasAttribute("ztt-drop-parent"), false);
  input.onDragEnd();
  void A;
});

test("the drop label shows the whole title and leaves truncation to CSS", () => {
  make("A");
  const B = make("B");
  B.label = "A title well over twenty-eight characters long";
  const X = make("X");
  input.onDragStart(event("dragstart", X, { x: 10, y: 75 }));
  input.onDragOver(event("dragover", B, { payload: X, x: 36, y: 55 }));
  const label = document.body.childNodes.find(n => n.id === "ztt-drop-label");
  const title = label.childNodes.find(n => n.className === "ztt-drop-title");
  assert.equal(title.textContent, B.label);
});

test("a mouseup ends a drag that never started", () => {
  const A = make("A");
  input.onDragStart(event("dragstart", A));
  input.onMouseUp();
  assert.equal(A.hasAttribute("ztt-drag-source"), false);
});
