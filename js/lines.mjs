/** The x of a connector column's trunk inside a row's line box, as a CSS expression (no calc()). */
const trunk = (column, kind) => `${column} * var(--ztt-indent) + var(--ztt-trunk-x-${kind})`;

const position = (x, y, rtl) => (rtl ? `right ${x} top ${y}` : `${x} ${y}`);

const railLayer = (column, kind, rtl, image = "var(--ztt-rail-image)") =>
  `${image} ${position(`calc(${trunk(column, kind)} - var(--ztt-line-width) / 2)`, "0px", rtl)} / var(--ztt-line-width) 100% no-repeat`;

const branchLayers = (column, kind, continues, rtl) => [
  railLayer(column, kind, rtl, continues ? "var(--ztt-rail-image)" : "var(--ztt-rail-top-image)"),
  `${rtl ? "var(--ztt-arc-image-rtl)" : "var(--ztt-arc-image)"} ` +
    `${position(`calc(${trunk(column, kind)} - var(--ztt-line-width) / 2)`, "var(--ztt-arc-y)", rtl)} / var(--ztt-arc-size) var(--ztt-arc-size) no-repeat`,
  "var(--ztt-rail-image) " +
    position(`calc(${trunk(column, kind)} + var(--ztt-arc-radius))`, "var(--ztt-mid)", rtl) +
    ` / var(--ztt-branch-length-${kind}) var(--ztt-line-width) no-repeat`,
];

/**
 * A row's connector lines from its layout `columns`: `rails` and `hover`
 * (lines of `hoverOwner`) as CSS background layer lists, and `hits`, one
 * click target per line part: { column, kind, part: "rail"|"top"|"arm",
 * owner, x (the trunk's x), arm (the branch length) } with x and arm as CSS
 * values.
 */
export function rowLines(columns, hoverOwner, rtl) {
  const rails = [];
  const hover = [];
  const hits = [];
  for (const { column, owner, ownerKind, own, continues } of columns) {
    const layers = own ? branchLayers(column, ownerKind, continues, rtl) : [railLayer(column, ownerKind, rtl)];
    (owner === hoverOwner ? hover : rails).push(...layers);
    for (const part of own ? [continues ? "rail" : "top", "arm"] : ["rail"]) {
      hits.push({
        column,
        kind: ownerKind,
        part,
        owner,
        x: `calc(${trunk(column, ownerKind)})`,
        arm: `var(--ztt-branch-length-${ownerKind})`,
      });
    }
  }
  return { rails: rails.join(", "), hover: hover.join(", "), hits };
}
