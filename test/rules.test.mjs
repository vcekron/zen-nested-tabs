import { test } from "node:test";
import assert from "node:assert/strict";
import { ancestors, positionalParent, nextRepairMove, dropTarget } from "../js/layout.mjs";

const tree = { B: "A", C: "B", D: "A" };
const parentOf = k => tree[k] ?? null;

test("positionalParent joins next's level when next hangs under prev or its ancestors", () => {
  assert.equal(positionalParent("A", "B", parentOf), "A");
  assert.equal(positionalParent("C", "D", parentOf), "A");
  assert.equal(positionalParent("B", "C", parentOf), "B");
});

test("positionalParent is top level otherwise", () => {
  assert.equal(positionalParent(null, "B", parentOf), null);
  assert.equal(positionalParent("D", "E", parentOf), null);
  assert.equal(positionalParent("E", "B", parentOf), null);
});

const repairAll = (order, parents, fixed = []) => {
  let list = order.split(" ");
  for (let pass = 0; pass < 200; pass++) {
    const live = k => (parents[k] && list.includes(parents[k]) ? parents[k] : null);
    const items = list.map(key => ({ key, parent: live(key), orphan: !!parents[key] && !list.includes(parents[key]) }));
    const move = nextRepairMove(items);
    if (!move) {
      return list.join(" ");
    }
    const isUnder = (a, k) => { for (let p = live(k); p; p = live(p)) if (p === a) return true; return false; };
    const moving = [move.key, ...list.filter(k => isUnder(move.key, k))];
    assert.ok(!fixed.includes(move.key), "a folder was moved");
    list = list.filter(k => !moving.includes(k));
    list.splice(list.indexOf(move.anchor) + 1, 0, ...moving);
  }
  return "GAVE UP";
};

const P = { VERK: "SWE", ZAG: "VERK", RTX30: "VERK", LEAF: "RTX30", TAV: "SWE", NOM: "SWE" };
for (const [name, order, want] of [
  ["a scrambled tree", "SWE VERK TAV ZAG RTX30 NOM LEAF", "SWE VERK ZAG RTX30 LEAF TAV NOM"],
  ["a sibling inside another subtree", "SWE VERK TAV ZAG RTX30 LEAF NOM", "SWE VERK ZAG RTX30 LEAF TAV NOM"],
  ["an ordered tree", "SWE VERK ZAG RTX30 LEAF TAV NOM", "SWE VERK ZAG RTX30 LEAF TAV NOM"],
  ["an orphan whose parent is closed", "SWE TAV ZAG NOM", "SWE TAV ZAG NOM"],
  ["an orphan subtree with its leaf at the end", "SWE TAV ZAG RTX30 NOM LEAF", "SWE TAV ZAG RTX30 LEAF NOM"],
  ["a child above its parent", "SWE LEAF VERK ZAG RTX30 TAV NOM", "SWE VERK ZAG RTX30 LEAF TAV NOM"],
  ["a subtree split by a sibling", "SWE VERK RTX30 TAV LEAF ZAG NOM", "SWE VERK RTX30 LEAF ZAG TAV NOM"],
  ["a floating block inside a floating block", "SWE TAV RTX30 ZAG LEAF NOM", "SWE TAV RTX30 LEAF ZAG NOM"],
]) {
  test(`repair: ${name}`, () => assert.equal(repairAll(order, P), want));
}

test("a subtree split by a folder moves its tail above the folder", () => {
  assert.equal(repairAll("A F B", { B: "A" }, ["F"]), "A B F");
});

const rows = [
  { key: "A", depth: 0, top: 0, bottom: 36, left: 10, right: 250 },
  { key: "B", depth: 1, top: 40, bottom: 76, left: 36, right: 250 },
  { key: "C", depth: 0, top: 80, bottom: 116, left: 10, right: 250 },
];
const at = (x, y) => ({ x: x + 5, y, grabOffset: 5 });

test("dropTarget picks the gap by row midpoints", () => {
  const t = dropTarget(rows, at(10, 50), null);
  assert.equal(t.prev, "A");
  assert.equal(t.next, "B");
  assert.equal(t.y, 38);
  assert.equal(t.key, "A|B");
});

test("dropTarget clamps the depth to what the gap allows", () => {
  assert.equal(dropTarget(rows, at(10, 50), null).depth, 1);
  assert.equal(dropTarget(rows, at(10 + 2 * 26, 90), null).depth, 2);
  assert.equal(dropTarget(rows, at(10 + 5 * 26, 90), null).depth, 2);
  assert.equal(dropTarget(rows, at(10 - 26, 90), null).depth, 0);
});

test("dropTarget keeps the previous depth until the edge is well into another level", () => {
  const previous = { key: "B|C", depth: 1 };
  assert.equal(dropTarget(rows, at(10 + 1.6 * 26, 90), previous).depth, 1);
  assert.equal(dropTarget(rows, at(10 + 1.7 * 26, 90), previous).depth, 2);
});

test("dropTarget places the line just outside the first and last rows", () => {
  assert.equal(dropTarget(rows, at(10, -5), null).y, -2);
  assert.equal(dropTarget(rows, at(10, 200), null).y, 118);
});

test("dropTarget starts the line at the chosen depth", () => {
  const t = dropTarget(rows, at(10 + 2 * 26, 90), null);
  assert.equal(t.left, 10 + 2 * 26);
  assert.equal(t.right, 250);
});

test("dropTarget has nowhere to go without rows", () => {
  assert.equal(dropTarget([], at(0, 0), null), null);
});

test("ancestors walks up to the root", () => {
  assert.deepEqual([...ancestors("C", parentOf)], ["B", "A"]);
  assert.deepEqual([...ancestors("A", parentOf)], []);
});

test("ancestors stops at a cycle", () => {
  const cycle = { a: "b", b: "a" };
  assert.deepEqual([...ancestors("a", k => cycle[k] ?? null)], ["b"]);
  assert.deepEqual([...ancestors("a", k => ({ a: "a" })[k] ?? null)], []);
  const lasso = { x: "a", a: "b", b: "a" };
  assert.deepEqual([...ancestors("x", k => lasso[k] ?? null)], ["a", "b"]);
});

test("positionalParent and nextRepairMove terminate on a cycle", () => {
  const cycle = { a: "b", b: "a" };
  assert.equal(positionalParent("a", "b", k => cycle[k] ?? null), "a");
  const items = [
    { key: "a", parent: "b", orphan: false },
    { key: "x", parent: null, orphan: false },
    { key: "b", parent: "a", orphan: false },
  ];
  assert.notEqual(nextRepairMove(items), undefined);
});

test("dropTarget never nests under a folder row", () => {
  const withFolder = [
    { key: "P1", depth: 0, top: 0, bottom: 36, left: 10, right: 250 },
    { key: "f:F", depth: 0, fixed: true, top: 40, bottom: 116, left: 10, right: 250 },
    { key: "P2", depth: 0, top: 120, bottom: 156, left: 10, right: 250 },
  ];
  const t = dropTarget(withFolder, at(10 + 3 * 26, 117), null);
  assert.equal(t.prev, "f:F");
  assert.equal(t.next, "P2");
  assert.equal(t.depth, 0);
  assert.equal(t.y, 118);
  assert.equal(dropTarget(withFolder, at(10 + 3 * 26, 30), null).next, "f:F");
});

test("dropTarget mirrors depth and line in right-to-left layouts", () => {
  const rtlRows = [
    { key: "A", depth: 0, top: 0, bottom: 36, left: 10, right: 250 },
    { key: "B", depth: 1, top: 40, bottom: 76, left: 10, right: 224 },
    { key: "C", depth: 0, top: 80, bottom: 116, left: 10, right: 250 },
  ];
  const rtlAt = (x, y) => ({ x: x - 20, y, grabOffset: 20 });
  assert.equal(dropTarget(rtlRows, rtlAt(250 - 2 * 26, 90), null, true).depth, 2);
  assert.equal(dropTarget(rtlRows, rtlAt(250, 90), null, true).depth, 0);
  const t = dropTarget(rtlRows, rtlAt(250 - 26, 90), null, true);
  assert.equal(t.depth, 1);
  assert.equal(t.left, 10);
  assert.equal(t.right, 250 - 26);
});

test("repair converges to a fixpoint for random forests and keeps top-level order", () => {
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = list => list[Math.floor(random() * list.length)];
  for (let round = 0; round < 500; round++) {
    const size = 2 + Math.floor(random() * 11);
    const keys = Array.from({ length: size }, (_, i) => `k${i}`);
    const parents = {};
    keys.forEach((key, i) => {
      const roll = random();
      if (i && roll < 0.6) parents[key] = pick(keys.slice(0, i));
      else if (roll < 0.7) parents[key] = "gone";
    });
    const order = [...keys].sort(() => random() - 0.5);
    const fixed = [];
    for (let i = Math.floor(random() * 3); i > 0; i--) {
      const key = `F${i}`;
      fixed.push(key);
      order.splice(Math.floor(random() * (order.length + 1)), 0, key);
    }
    const repaired = repairAll(order.join(" "), parents, fixed);
    assert.notEqual(repaired, "GAVE UP", order.join(" "));
    assert.equal(repairAll(repaired, parents, fixed), repaired, order.join(" "));
    const unmoved = list => list.split(" ").filter(k => !parents[k] || parents[k] === "gone").join(" ");
    assert.equal(unmoved(repaired), unmoved(order.join(" ")), order.join(" "));
  }
});
