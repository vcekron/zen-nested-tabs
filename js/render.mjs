import { TREE } from "./config.mjs";
import { rowLines } from "./lines.mjs";
import { allTabs } from "./model.mjs";

/** A new HTML element in the chrome document. */
export const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);

export const isRtl = () => document.documentElement.matches(":-moz-locale-dir(rtl)");

export const isSidebarExpanded = () => gNavToolbox.getAttribute("zen-sidebar-expanded") === "true";

const sectionOf = el => el.closest(".zen-workspace-pinned-tabs-section, .zen-workspace-normal-tabs-section");

const hostOf = node =>
  ({
    tab: el => el.querySelector(":scope > .tab-stack"),
    folder: el => el.querySelector(":scope > .tab-group-label-container"),
    split: el => el,
  })[node.kind](node.element);

const setStyle = (el, property, value) => {
  if (el.style.getPropertyValue(property) !== value) {
    el.style.setProperty(property, value);
  }
};

const px = value => `${Math.round(value * 100) / 100}px`;

/** Writes the tree layout into Zen's sidebar: tab attributes, chevrons, connector lines, fold animations. */
export class Renderer {
  #folds = new WeakMap();
  #hoverOwner = null;
  #drawnHover = null;
  #last = null;
  #linesQueued = false;
  #measureQueued = false;

  /** `nodes` from TreeModel.sidebarNodes() and their computeLayout() entries. */
  render(nodes, layout) {
    const rtl = isRtl();
    this.#foldAll(nodes, layout);
    const rendered = new Set();
    for (const node of nodes) {
      const entry = layout.get(node.key);
      if (node.kind === "tab") {
        rendered.add(node.element);
        this.#renderTab(node.element, entry);
      }
      if (node.kind !== "folder") {
        setStyle(node.element, "--ztt-flatten", String(entry.flatten));
      }
      this.#renderLines(node, entry, rtl);
    }
    for (const tab of allTabs()) {
      if (!rendered.has(tab) && !tab._zttPending && tab.hasAttribute("ztt-depth")) {
        this.clear(tab);
      }
    }
    this.#last = { nodes, layout };
    this.#drawnHover = this.#hoverOwner;
    this.measure();
    this.#measureAfterAnimations(gBrowser.tabContainer);
  }

  /** The computeLayout() entry `key` was last drawn with, or null. */
  entryOf(key) {
    return this.#last?.layout.get(key) ?? null;
  }

  /** Redraws the connectors with the lines owned by `key` (a layout key or null) highlighted. */
  setHoverOwner(key) {
    if (key === this.#hoverOwner) {
      return;
    }
    this.#hoverOwner = key;
    if (this.#linesQueued || !this.#last) {
      return;
    }
    this.#linesQueued = true;
    requestAnimationFrame(() => {
      this.#linesQueued = false;
      const owners = new Set([this.#drawnHover, this.#hoverOwner]);
      this.#drawnHover = this.#hoverOwner;
      const rtl = isRtl();
      for (const node of this.#last.nodes) {
        const entry = this.#last.layout.get(node.key);
        if (entry.columns.some(c => owners.has(c.owner))) {
          this.#renderLines(node, entry, rtl);
        }
      }
    });
  }

  #measureAfterAnimations(element) {
    requestAnimationFrame(() => {
      const animations = element
        .getAnimations({ subtree: true })
        .filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime));
      Promise.allSettled(animations.map(a => a.finished)).then(() => this.#scheduleMeasure());
    });
  }

  #scheduleMeasure() {
    if (this.#measureQueued) {
      return;
    }
    this.#measureQueued = true;
    requestAnimationFrame(() => {
      this.#measureQueued = false;
      this.measure();
    });
  }

  /** Removes everything the tree drew on `tab`. */
  clear(tab) {
    if (this.#folds.has(tab)) {
      this.#endFold(tab);
    }
    for (const attr of ["ztt-depth", "ztt-hidden", "ztt-has-children", "ztt-collapsed", "aria-expanded"]) {
      tab.removeAttribute(attr);
    }
    tab.style.removeProperty("--ztt-depth");
    tab.style.removeProperty("--ztt-flatten");
    tab.querySelector(":scope > .tab-stack > .ztt-lines")?.remove();
    tab.querySelector(".tab-icon-stack > .ztt-chevron")?.remove();
  }

  #renderTab(tab, { depth, hidden, descendants, collapsed }) {
    if (tab.getAttribute("ztt-depth") !== String(depth)) {
      tab.setAttribute("ztt-depth", depth);
    }
    setStyle(tab, "--ztt-depth", String(depth));
    tab.toggleAttribute("ztt-hidden", hidden);
    tab.toggleAttribute("ztt-has-children", descendants > 0);
    tab.toggleAttribute("ztt-collapsed", collapsed);
    if (descendants > 0) {
      this.#ensureChevron(tab);
      tab.setAttribute("aria-expanded", String(!collapsed));
    } else {
      tab.removeAttribute("aria-expanded");
    }
  }

  #ensureChevron(tab) {
    const stack = tab.querySelector(".tab-icon-stack");
    if (stack && !stack.querySelector(":scope > .ztt-chevron")) {
      const chevron = document.createXULElement("hbox");
      chevron.className = "ztt-chevron";
      stack.append(chevron);
    }
  }

  #renderLines(node, entry, rtl) {
    if (entry.hidden) {
      return;
    }
    const host = hostOf(node);
    if (!host) {
      return;
    }
    let box = host.querySelector(":scope > .ztt-lines");
    if (!entry.columns.length) {
      box?.remove();
      return;
    }
    if (!box) {
      box = html("div");
      box.className = "ztt-lines";
      host.append(box);
    }
    const { rails, hover, hits } = rowLines(entry.columns, this.#hoverOwner, rtl);
    setStyle(box, "--ztt-columns", String(entry.columns.at(-1).column + 1));
    setStyle(box, "--ztt-rails", rails || "none");
    setStyle(box, "--ztt-rails-hover", hover || "none");
    this.#renderHits(box, hits);
  }

  #renderHits(box, hits) {
    const key = hits.map(h => `${h.column}:${h.kind}:${h.part}:${h.owner}`).join(" ");
    if (box._zttHitsKey === key) {
      return;
    }
    box._zttHitsKey = key;
    box.replaceChildren(
      ...hits.map(({ part, owner, x, arm }) => {
        const hit = html("div");
        hit.className = "ztt-hit";
        hit.setAttribute("ztt-part", part);
        hit.style.setProperty("--ztt-x", x);
        hit.style.setProperty("--ztt-arm", arm);
        hit._zttOwner = owner;
        return hit;
      })
    );
  }

  /** Starts the fold animations of every tab whose hidden state changes, reading all frames before writing. */
  #foldAll(nodes, layout) {
    if (!this.#last || !isSidebarExpanded() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const folds = [];
    for (const node of nodes) {
      const tab = node.element;
      const { hidden } = layout.get(node.key);
      if (node.kind === "tab" && !tab.hidden && tab.hasAttribute("ztt-depth") && tab.hasAttribute("ztt-hidden") !== hidden) {
        folds.push({ tab, hide: hidden });
      }
    }
    if (!folds.length) {
      return;
    }
    for (const fold of folds) {
      fold.current = this.#folds.has(fold.tab) ? this.#foldFrame(fold.tab) : null;
    }
    for (const { tab } of folds) {
      this.#folds.get(tab)?.cancel();
      tab.setAttribute("ztt-folding", "");
    }
    for (const fold of folds) {
      fold.shown = this.#foldFrame(fold.tab);
    }
    for (const { tab, hide, current, shown } of folds) {
      this.#animateFold(tab, hide, current, shown);
    }
  }

  #animateFold(tab, hide, current, shown) {
    const folded = { ...shown, height: "0px", opacity: "0", marginTop: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px" };
    const animation = tab.animate([current ?? (hide ? shown : folded), hide ? folded : shown], {
      duration: TREE.foldDuration,
      easing: TREE.foldEasing,
      fill: "forwards",
    });
    this.#folds.set(tab, animation);
    animation.finished.then(
      () => {
        if (this.#folds.get(tab) === animation) {
          this.#endFold(tab);
          this.#scheduleMeasure();
        }
      },
      () => {}
    );
  }

  #foldFrame(tab) {
    const style = getComputedStyle(tab);
    return {
      height: style.height,
      minHeight: "0px",
      opacity: style.opacity,
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
    };
  }

  #endFold(tab) {
    const animation = this.#folds.get(tab);
    this.#folds.delete(tab);
    tab.removeAttribute("ztt-folding");
    animation?.cancel();
  }

  /** Measures the icon centres and row gaps the lines depend on. */
  measure() {
    const root = document.documentElement;
    const rtl = isRtl();
    const centre = (row, icon) => {
      const r = row?.getBoundingClientRect();
      const i = icon?.getBoundingClientRect();
      if (!r?.width || !i?.width) {
        return null;
      }
      return rtl ? r.right - (i.left + i.width / 2) : i.left + i.width / 2 - r.left;
    };

    const space = gZenWorkspaces.activeWorkspaceElement;
    const visible = [];
    for (const node of this.#last?.nodes ?? []) {
      const entry = this.#last.layout.get(node.key);
      if (entry.hidden || (node.inCollapsedFolder && !node.folderActive) || !space?.contains(node.element)) {
        continue;
      }
      const host = hostOf(node);
      const rect = host?.getBoundingClientRect();
      if (rect?.height) {
        visible.push({ node, host, rect });
      }
    }
    const tab = visible.find(
      ({ node }) =>
        node.kind === "tab" && !node.element.hasAttribute("zen-pinned-changed") && !node.element.hasAttribute("busy")
    )?.node.element;
    const tabX = centre(
      tab?.querySelector(".tab-stack"),
      [".tab-icon-image", ".tab-icon-stack"].map(s => tab?.querySelector(s)).find(el => el?.getBoundingClientRect().width)
    );
    if (tabX !== null) {
      setStyle(root, "--ztt-tab-icon-x", px(tabX));
    }
    const folder = visible.find(({ node }) => node.kind === "folder")?.node.element;
    const folderX = centre(
      folder?.querySelector(":scope > .tab-group-label-container"),
      folder?.querySelector(":scope > .tab-group-label-container .tab-group-folder-icon")
    );
    if (folderX !== null) {
      setStyle(root, "--ztt-folder-icon-x", px(folderX));
    }

    const rows = visible.map(({ node, host, rect }) => ({ host, rect, section: sectionOf(node.element) }));
    rows.forEach(({ host, rect, section }, i) => {
      const box = host.querySelector(":scope > .ztt-lines");
      if (!box) {
        return;
      }
      const halfGap = (neighbour, gap) =>
        neighbour?.section === section && gap >= 0 && gap < rect.height ? gap / 2 : 0;
      setStyle(box, "--ztt-overhang-top", px(halfGap(rows[i - 1], rect.top - rows[i - 1]?.rect.bottom)));
      setStyle(box, "--ztt-overhang-bottom", px(halfGap(rows[i + 1], rows[i + 1]?.rect.top - rect.bottom)));
    });
  }
}
