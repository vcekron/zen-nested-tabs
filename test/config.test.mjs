import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { rootVars, applyConfig, TREE } from "../js/config.mjs";
import { rowLines } from "../js/lines.mjs";

test("rootVars writes every CSS-used value once", () => {
  assert.deepEqual(rootVars(), {
    "--ztt-indent": "26px",
    "--ztt-line-width": "2px",
    "--ztt-line-opacity": "0.25",
    "--ztt-hover-line-opacity": "0.5",
    "--ztt-arc-radius": "7px",
    "--ztt-branch-reach": "2px",
    "--ztt-hit-width": "12px",
    "--ztt-chevron-duration": "100ms",
    "--ztt-sharing-color": "rgb(224, 41, 29)",
    "--ztt-zen-folder-step": "14px",
    "--ztt-press-transition": "scale 0.1s ease",
  });
});

test("applyConfig sets each root var on the given style", () => {
  const set = {};
  applyConfig({ setProperty: (k, v) => (set[k] = v) });
  assert.deepEqual(set, rootVars());
});

test("chrome.css never defines or falls back for a config var", () => {
  const css = readFileSync(new URL("../chrome.css", import.meta.url), "utf8");
  for (const name of Object.keys(rootVars())) {
    assert.doesNotMatch(css, new RegExp(`${name}\\s*:`), `${name} defined in CSS`);
    assert.doesNotMatch(css, new RegExp(`var\\(${name}\\s*,`), `${name} has a fallback`);
  }
});

const css = readFileSync(new URL("../chrome.css", import.meta.url), "utf8");
const jsDir = new URL("../js/", import.meta.url);
const js = readdirSync(jsDir).map(name => readFileSync(new URL(name, jsDir), "utf8")).join("\n");
const read = text => new Set([...text.matchAll(/var\((--ztt-[\w-]+)/g)].map(m => m[1]));
const defined = new Set([
  ...Object.keys(rootVars()),
  ...[...css.matchAll(/(--ztt-[\w-]+)\s*:/g)].map(m => m[1]),
  ...[...js.matchAll(/"(--ztt-[\w-]+)"/g)].map(m => m[1]),
]);

test("every root var is read by chrome.css", () => {
  const used = read(css);
  for (const name of Object.keys(rootVars())) {
    assert.ok(used.has(name), `${name} is never read`);
  }
});

test("every --ztt var chrome.css or the drawn lines read is defined", () => {
  const lines = ["tab", "folder"].flatMap(kind =>
    [false, true].map(rtl => {
      const { rails, hits } = rowLines([{ column: 0, owner: "A", ownerKind: kind, own: true, continues: false }], null, rtl);
      return rails + hits.map(h => h.x + h.arm).join("");
    })
  );
  for (const name of read(css + lines.join(""))) {
    assert.ok(defined.has(name), `${name} is read but never defined`);
  }
});

test("timing values the JS reads directly stay pinned", () => {
  assert.equal(TREE.foldDuration, 180);
  assert.equal(TREE.foldEasing, "ease-in-out");
  assert.equal(TREE.dragExpandDelay, 600);
  assert.equal(TREE.dragScrollZone, 36);
  assert.equal(TREE.dragScrollDivisor, 3);
});
