export const TREE = {
  indent: 26,
  lineWidth: 2,
  lineOpacity: 0.25,
  hoverLineOpacity: 0.5,
  arcRadius: 7,
  branchReach: 2,
  hitWidth: 12,
  foldDuration: 180,
  foldEasing: "ease-in-out",
  chevronDuration: 100,
  sharingColor: "rgb(224, 41, 29)",
  dragExpandDelay: 600,
  dragScrollZone: 36,
  dragScrollDivisor: 3,
  dragLevelHysteresis: 0.65,
  dropEdgeOffset: 2,
};

export const ZEN = {
  folderStep: 14,
  pressTransition: "scale 0.1s ease",
};

/** The `:root` custom properties chrome.css reads, as name → CSS value. */
export function rootVars() {
  return {
    "--ztt-indent": `${TREE.indent}px`,
    "--ztt-line-width": `${TREE.lineWidth}px`,
    "--ztt-line-opacity": String(TREE.lineOpacity),
    "--ztt-hover-line-opacity": String(TREE.hoverLineOpacity),
    "--ztt-arc-radius": `${TREE.arcRadius}px`,
    "--ztt-branch-reach": `${TREE.branchReach}px`,
    "--ztt-hit-width": `${TREE.hitWidth}px`,
    "--ztt-chevron-duration": `${TREE.chevronDuration}ms`,
    "--ztt-sharing-color": TREE.sharingColor,
    "--ztt-zen-folder-step": `${ZEN.folderStep}px`,
    "--ztt-press-transition": ZEN.pressTransition,
  };
}

/** Writes rootVars() onto `style` (the root element's style). */
export function applyConfig(style) {
  for (const [name, value] of Object.entries(rootVars())) {
    style.setProperty(name, value);
  }
}
