import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "../js/layout.mjs";

const n = (key, parent, extra = {}) => ({
  key, parent, kind: "tab", collapsed: false, selected: false, revealed: false, inCollapsedFolder: false, ...extra,
});
const col = (column, owner, own, continues, ownerKind = "tab") => ({ column, owner, ownerKind, own, continues });

test("nested tabs get depth and columns", () => {
  const l = computeLayout([n("A", null), n("B", "A"), n("C", "B"), n("D", "A")]);
  assert.equal(l.get("A").depth, 0);
  assert.equal(l.get("C").depth, 2);
  assert.deepEqual(l.get("C").columns, [col(0, "A", false, true), col(1, "B", true, false)]);
  assert.deepEqual(l.get("B").columns, [col(0, "A", true, true)]);
  assert.deepEqual(l.get("D").columns, [col(0, "A", true, false)]);
  assert.equal(l.get("A").descendants, 3);
  assert.equal(l.get("B").descendants, 1);
});

test("a collapsed parent hides its descendants", () => {
  const l = computeLayout([n("A", null, { collapsed: true }), n("B", "A"), n("C", "B"), n("D", "A")]);
  assert.deepEqual(["B", "C", "D"].map(k => l.get(k).hidden), [true, true, true]);
  assert.equal(l.get("A").hidden, false);
  assert.equal(l.get("A").collapsed, true);
});

test("a selected tab under a collapsed parent is revealed one level below the outermost collapsed ancestor", () => {
  const l = computeLayout([
    n("A", null, { collapsed: true }), n("B", "A", { collapsed: true }), n("C", "B", { selected: true }), n("D", "A"),
  ]);
  const c = l.get("C");
  assert.equal(c.hidden, false);
  assert.equal(c.revealed, true);
  assert.equal(c.depth, 1);
  assert.deepEqual(c.columns, [col(0, "A", true, false)]);
  assert.equal(l.get("B").hidden, true);
});

test("a revealed tab stays revealed until its ancestors expand", () => {
  const kept = computeLayout([n("A", null, { collapsed: true }), n("C", "A", { revealed: true })]);
  assert.equal(kept.get("C").revealed, true);
  assert.equal(kept.get("C").hidden, false);
  const expanded = computeLayout([n("A", null), n("C", "A", { revealed: true })]);
  assert.equal(expanded.get("C").revealed, false);
});

test("folder items hang from the folder, tab trees continue below", () => {
  const l = computeLayout([
    n("F", null, { kind: "folder" }), n("T1", "F"), n("T2", "T1"), n("T3", "F"),
  ]);
  assert.equal(l.get("T1").depth, 0);
  assert.deepEqual(l.get("T1").columns, [col(0, "F", true, true, "folder")]);
  assert.equal(l.get("T2").depth, 1);
  assert.deepEqual(l.get("T2").columns, [col(0, "F", false, true, "folder"), col(1, "T1", true, false)]);
  assert.deepEqual(l.get("T3").columns, [col(0, "F", true, false, "folder")]);
  assert.equal(l.get("F").descendants, 0);
});

test("rows inside a collapsed folder have no columns", () => {
  const l = computeLayout([
    n("F", null, { kind: "folder", collapsed: true }), n("T1", "F", { inCollapsedFolder: true, selected: true }),
  ]);
  assert.deepEqual(l.get("T1").columns, []);
  assert.equal(l.get("T1").hidden, false);
});

test("rows inside a collapsed folder are no one's last visible child", () => {
  const l = computeLayout([
    n("G", null, { kind: "folder" }),
    n("F", "G", { kind: "folder", collapsed: true }),
    n("T", "F", { inCollapsedFolder: true }),
    n("U", "G"),
    n("V", "G", { inCollapsedFolder: true }),
  ]);
  assert.deepEqual(l.get("F").columns, [col(0, "G", true, true, "folder")]);
  assert.deepEqual(l.get("U").columns, [col(0, "G", true, false, "folder")]);
});

test("split views are leaves", () => {
  const l = computeLayout([n("F", null, { kind: "folder" }), n("S", "F", { kind: "split" }), n("T", "F")]);
  assert.deepEqual(l.get("S").columns, [col(0, "F", true, true, "folder")]);
  assert.equal(l.get("S").descendants, 0);
  assert.equal(l.get("S").depth, 0);
});

test("a collapsed tab without children is reported expanded", () => {
  const l = computeLayout([n("A", null, { collapsed: true }), n("B", null)]);
  assert.equal(l.get("A").collapsed, false);
});

test("rows inside a collapsed folder are left to Zen: no depth, never hidden", () => {
  const l = computeLayout([
    n("F", null, { kind: "folder", collapsed: true }),
    n("P", "F", { inCollapsedFolder: true, collapsed: true }),
    n("K", "P", { inCollapsedFolder: true, selected: false }),
  ]);
  assert.equal(l.get("K").depth, 0);
  assert.equal(l.get("K").hidden, false);
  assert.deepEqual(l.get("K").columns, []);
});

test("an active tab inside a collapsed folder hangs one level below it, like a revealed tab", () => {
  const l = computeLayout([
    n("O", null, { kind: "folder" }),
    n("G", "O", { kind: "folder", collapsed: true }),
    n("S", "G", { kind: "folder", inCollapsedFolder: true }),
    n("P", "S", { inCollapsedFolder: true }),
    n("K", "P", { inCollapsedFolder: true, folderActive: true, selected: true }),
    n("L", "O"),
  ]);
  const k = l.get("K");
  assert.equal(k.depth, 0);
  assert.equal(k.hidden, false);
  assert.equal(k.flatten, 1);
  assert.deepEqual(k.columns, [col(0, "O", false, true, "folder"), col(1, "G", true, false, "folder")]);
  assert.deepEqual(l.get("G").columns, [col(0, "O", true, true, "folder")]);
  assert.deepEqual(l.get("P").columns, []);
});

test("rows outside collapsed folders are not flattened", () => {
  assert.equal(computeLayout([n("A", null)]).get("A").flatten, 0);
});

test("computeLayout terminates on a cycle", () => {
  const nodes = [
    { key: "A", parent: "B", kind: "tab", collapsed: false, selected: false, revealed: false, inCollapsedFolder: false },
    { key: "B", parent: "A", kind: "tab", collapsed: false, selected: false, revealed: false, inCollapsedFolder: false },
  ];
  const layout = computeLayout(nodes);
  assert.equal(layout.size, 2);
  assert.equal(layout.get("A").depth, 1);
});

test("a folder-active row with no collapsed folder above shows no ancestors", () => {
  const nodes = [
    { key: "P", parent: null, kind: "tab", collapsed: false, selected: false, revealed: false, inCollapsedFolder: false },
    { key: "C", parent: "P", kind: "tab", collapsed: false, selected: true, revealed: false, inCollapsedFolder: true, folderActive: true },
  ];
  const entry = computeLayout(nodes).get("C");
  assert.equal(entry.depth, 0);
  assert.equal(entry.flatten, 0);
  assert.deepEqual(entry.columns, []);
});

test("each row lists the tab ancestors drawn above it, nearest first", () => {
  const l = computeLayout([n("R", null, { collapsed: true }), n("A", "R"), n("B", "A", { revealed: true }), n("X", null), n("Y", "X"), n("Z", "Y")]);
  assert.deepEqual(l.get("B").chain, ["R"]);
  assert.equal(l.get("B").depth, 1);
  assert.deepEqual(l.get("Z").chain, ["Y", "X"]);
  assert.deepEqual(l.get("X").chain, []);
});
