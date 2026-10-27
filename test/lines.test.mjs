import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "../js/layout.mjs";
import { rowLines } from "../js/lines.mjs";

const n = (key, parent, extra = {}) => ({
  key, parent, kind: "tab", collapsed: false, selected: false, revealed: false, inCollapsedFolder: false, ...extra,
});
const columnsOf = (nodes, key) => computeLayout(nodes).get(key).columns;
const tree = [n("A", null), n("B", "A"), n("C", "B"), n("D", "A")];
const layers = value => (value ? value.split(", ") : []);

test("a row's lines are one rail per passing column plus top rail, arc and arm for its own branch", () => {
  const { rails, hover } = rowLines(columnsOf(tree, "C"), null, false);
  const list = layers(rails);
  assert.equal(list.length, 4);
  assert.match(list[0], /^var\(--ztt-rail-image\) calc\(0 \* var\(--ztt-indent\)/);
  assert.match(list[1], /^var\(--ztt-rail-top-image\) calc\(1 \* var\(--ztt-indent\)/);
  assert.match(list[2], /^var\(--ztt-arc-image\) /);
  assert.match(list[3], /\/ var\(--ztt-branch-length-tab\) var\(--ztt-line-width\) no-repeat$/);
  assert.equal(hover, "");
});

test("a continuing branch draws a full rail", () => {
  assert.match(layers(rowLines(columnsOf(tree, "B"), null, false).rails)[0], /^var\(--ztt-rail-image\) /);
});

test("the hovered owner's layers move to the hover layer", () => {
  const { rails, hover } = rowLines(columnsOf(tree, "C"), "B", false);
  assert.equal(layers(rails).length, 1);
  assert.equal(layers(hover).length, 3);
});

test("hits name the column, kind, part and owner of each line", () => {
  assert.deepEqual(rowLines(columnsOf(tree, "C"), null, false).hits.map(({ column, kind, part, owner }) => ({ column, kind, part, owner })), [
    { column: 0, kind: "tab", part: "rail", owner: "A" },
    { column: 1, kind: "tab", part: "top", owner: "B" },
    { column: 1, kind: "tab", part: "arm", owner: "B" },
  ]);
  assert.deepEqual(rowLines(columnsOf(tree, "B"), null, false).hits.map(h => h.part), ["rail", "arm"]);
});

test("a folder's column hangs from the folder icon", () => {
  const nodes = [n("F", null, { kind: "folder" }), n("T", "F")];
  const { rails, hits } = rowLines(columnsOf(nodes, "T"), null, false);
  assert.match(rails, /var\(--ztt-trunk-x-folder\)/);
  assert.doesNotMatch(rails, /--ztt-trunk-x-tab/);
  assert.equal(hits[0].kind, "folder");
});

test("right-to-left layers are positioned from the right", () => {
  const { rails } = rowLines(columnsOf(tree, "C"), null, true);
  for (const layer of layers(rails)) {
    assert.match(layer, /^var\(--ztt-[a-z-]+\) right /);
  }
  assert.match(rails, /--ztt-arc-image-rtl/);
});

test("a row without columns has no lines", () => {
  assert.deepEqual(rowLines([], null, false), { rails: "", hover: "", hits: [] });
});

test("branches meet the row's centre, not the centre of the overhanging box", () => {
  const list = layers(rowLines(columnsOf(tree, "C"), null, false).rails);
  assert.match(list[2], /var\(--ztt-arc-y\)/);
  assert.match(list[3], / var\(--ztt-mid\) \//);
});

const golden = {
  ltr:
    "var(--ztt-rail-image) calc(0 * var(--ztt-indent) + var(--ztt-trunk-x-tab) - var(--ztt-line-width) / 2) 0px / var(--ztt-line-width) 100% no-repeat, " +
    "var(--ztt-rail-top-image) calc(1 * var(--ztt-indent) + var(--ztt-trunk-x-tab) - var(--ztt-line-width) / 2) 0px / var(--ztt-line-width) 100% no-repeat, " +
    "var(--ztt-arc-image) calc(1 * var(--ztt-indent) + var(--ztt-trunk-x-tab) - var(--ztt-line-width) / 2) var(--ztt-arc-y) / var(--ztt-arc-size) var(--ztt-arc-size) no-repeat, " +
    "var(--ztt-rail-image) calc(1 * var(--ztt-indent) + var(--ztt-trunk-x-tab) + var(--ztt-arc-radius)) var(--ztt-mid) / var(--ztt-branch-length-tab) var(--ztt-line-width) no-repeat",
  rtl:
    "var(--ztt-rail-image) right calc(0 * var(--ztt-indent) + var(--ztt-trunk-x-tab) - var(--ztt-line-width) / 2) top 0px / var(--ztt-line-width) 100% no-repeat, " +
    "var(--ztt-rail-top-image) right calc(1 * var(--ztt-indent) + var(--ztt-trunk-x-tab) - var(--ztt-line-width) / 2) top 0px / var(--ztt-line-width) 100% no-repeat, " +
    "var(--ztt-arc-image-rtl) right calc(1 * var(--ztt-indent) + var(--ztt-trunk-x-tab) - var(--ztt-line-width) / 2) top var(--ztt-arc-y) / var(--ztt-arc-size) var(--ztt-arc-size) no-repeat, " +
    "var(--ztt-rail-image) right calc(1 * var(--ztt-indent) + var(--ztt-trunk-x-tab) + var(--ztt-arc-radius)) top var(--ztt-mid) / var(--ztt-branch-length-tab) var(--ztt-line-width) no-repeat",
};

test("a nested row's lines are exactly these layers, in both directions", () => {
  assert.equal(rowLines(columnsOf(tree, "C"), null, false).rails, golden.ltr);
  assert.equal(rowLines(columnsOf(tree, "C"), null, true).rails, golden.rtl);
});

test("hit targets sit on the trunk the lines are drawn from", () => {
  const { hits } = rowLines(columnsOf(tree, "C"), null, false);
  assert.deepEqual(
    hits.map(({ part, x, arm }) => [part, x, arm]),
    [
      ["rail", "calc(0 * var(--ztt-indent) + var(--ztt-trunk-x-tab))", "var(--ztt-branch-length-tab)"],
      ["top", "calc(1 * var(--ztt-indent) + var(--ztt-trunk-x-tab))", "var(--ztt-branch-length-tab)"],
      ["arm", "calc(1 * var(--ztt-indent) + var(--ztt-trunk-x-tab))", "var(--ztt-branch-length-tab)"],
    ]
  );
});
