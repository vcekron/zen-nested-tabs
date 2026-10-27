import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakes } from "./fakes.mjs";
import { TreeModel, KEYS } from "../js/model.mjs";
import { computeLayout } from "../js/layout.mjs";
import { Renderer } from "../js/render.mjs";

let f, model, renderer, normal;

const style = () => {
  const props = new Map();
  return {
    props,
    setProperty: (k, v) => props.set(k, String(v)),
    removeProperty: k => props.delete(k),
    getPropertyValue: k => props.get(k) ?? "",
  };
};
const descendants = el => el.children.flatMap(c => [c, ...descendants(c)]);
const hasClass = (el, cls) => (el.className ?? "").split(" ").includes(cls.slice(1));
const querySelector = (root, selector) => {
  const steps = [];
  let combinator = " ";
  for (const token of selector.split(/\s+/)) {
    if (token === ":scope") continue;
    if (token === ">") {
      combinator = ">";
      continue;
    }
    steps.push({ combinator, cls: token });
    combinator = " ";
  }
  let current = [root];
  for (const { combinator: c, cls } of steps) {
    current = current.flatMap(el => (c === ">" ? el.children : descendants(el)).filter(d => hasClass(d, cls)));
  }
  return current[0] ?? null;
};
const node = (className = "") => {
  const el = f.element({ className });
  return Object.assign(el, {
    children: [],
    style: style(),
    querySelector(selector) { return querySelector(this, selector); },
    append(...nodes) {
      for (const n of nodes) {
        n.parentNode = this;
        this.children.push(n);
      }
    },
    remove() {
      const siblings = this.parentNode?.children;
      siblings?.splice(siblings.indexOf(this), 1);
    },
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    },
    toggleAttribute(a, force = !(a in this.attrs)) {
      if (force) this.attrs[a] = "";
      else delete this.attrs[a];
      return force;
    },
  });
};
const make = (label, parent = null) => {
  const t = f.tab(label, normal, { stored: { [KEYS.id]: label.toLowerCase() } });
  const domTab = node("tabbrowser-tab");
  Object.assign(t, { children: domTab.children, style: domTab.style, querySelector: domTab.querySelector, append: domTab.append, toggleAttribute: domTab.toggleAttribute });
  const stack = node("tab-stack");
  const content = node("tab-content");
  content.append(node("tab-icon-stack"));
  stack.append(content);
  t.append(stack);
  model.load(t);
  if (parent) model.setParent(t, parent);
  return t;
};
const draw = () => {
  const nodes = model.sidebarNodes();
  renderer.render(nodes, computeLayout(nodes));
};
const linesOf = t => t.querySelector(":scope > .tab-stack > .ztt-lines");
const chevronOf = t => t.querySelector(".tab-icon-stack > .ztt-chevron");

beforeEach(() => {
  f = installFakes();
  model = new TreeModel();
  renderer = new Renderer();
  normal = f.space("w").normal;
  globalThis.document = {
    documentElement: Object.assign(node(), { matches: () => false }),
    createElementNS: () => node(),
    createXULElement: () => node(),
  };
  globalThis.gNavToolbox = { getAttribute: () => "true" };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.matchMedia = () => ({ matches: true });
  gZenWorkspaces.activeWorkspaceElement = null;
  gBrowser.tabContainer = {};
});

test("a parent row gets a chevron and the tab says whether it is expanded", () => {
  const P = make("P");
  const C = make("C", P);
  draw();
  assert.ok(chevronOf(P));
  assert.equal(P.getAttribute("aria-expanded"), "true");
  assert.equal(C.getAttribute("aria-expanded"), null);
  model.setCollapsed(P, true);
  draw();
  assert.equal(P.getAttribute("aria-expanded"), "false");
  assert.ok(C.hasAttribute("ztt-hidden"));
});

test("clear removes every attribute, property, line box and chevron", () => {
  const P = make("P");
  const C = make("C", P);
  draw();
  assert.ok(linesOf(C));
  for (const t of [P, C]) {
    renderer.clear(t);
    for (const attr of ["ztt-depth", "ztt-hidden", "ztt-has-children", "ztt-collapsed", "aria-expanded"]) {
      assert.equal(t.hasAttribute(attr), false, `${t.label} ${attr}`);
    }
    assert.equal(t.style.getPropertyValue("--ztt-depth"), "");
    assert.equal(t.style.getPropertyValue("--ztt-flatten"), "");
    assert.equal(linesOf(t), null);
    assert.equal(chevronOf(t), null);
  }
});

test("a row that no longer has columns loses its line box", () => {
  const P = make("P");
  const C = make("C", P);
  draw();
  assert.ok(linesOf(C));
  model.setParent(C, null);
  draw();
  assert.equal(linesOf(C), null);
});

test("hit targets carry their trunk position and owner", () => {
  const P = make("P");
  const C = make("C", P);
  draw();
  const hits = linesOf(C).children;
  assert.deepEqual(hits.map(h => h.getAttribute("ztt-part")), ["top", "arm"]);
  assert.equal(hits[0].style.getPropertyValue("--ztt-x"), "calc(0 * var(--ztt-indent) + var(--ztt-trunk-x-tab))");
  assert.equal(hits[1].style.getPropertyValue("--ztt-arm"), "var(--ztt-branch-length-tab)");
  assert.ok(hits.every(h => h._zttOwner === P._zttId));
});

test("a tab that left the trees is cleared on the next render", () => {
  const P = make("P");
  const C = make("C", P);
  draw();
  C.setAttribute("zen-essential", "true");
  draw();
  assert.equal(C.hasAttribute("ztt-depth"), false);
  assert.equal(P.hasAttribute("ztt-has-children"), false);
});
