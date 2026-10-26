// ==UserScript==
// @name           Zen Nested Tabs
// @description    Tree Style Tab-like nesting for Zen Browser's vertical tabs.
// @include        main
// @version        1.1.0
// ==/UserScript==

/*
 * Model
 * -----
 * The tab tree is the source of truth: one parent pointer per tab (a stable
 * id saved with SessionStore custom tab values). Children are ordered by
 * sidebar order. Only explicit tree operations change the tree: open (nest
 * under the opener), close (promote or close the subtree), move/drag
 * (re-parent from the drop position and bring the subtree along), nest /
 * un-nest, and leaving a list (pinning, folders, spaces, Essentials), where
 * the tab's children move up to its parent.
 *
 * Rendering (#normalize) only reads the tree. Depth, hidden state and child
 * counts come from parent pointers, never from sidebar order, so a tab that
 * is briefly out of place (closing, mid-move, just opened) can't cut anyone
 * off.
 *
 * Lists: nesting only happens between tabs that share a DOM parent (the
 * normal tabs list of a space, the pinned list, or a Zen folder). Essentials,
 * Glance tabs and Zen's empty placeholder tab are never part of a tree.
 */
(() => {
  "use strict";

  if (window.location.href !== "chrome://browser/content/browser.xhtml") {
    return;
  }
  if (window.gZenNestedTabs) {
    return;
  }

  const DEFAULT_INDENT_PX = 26;
  const MIN_INDENT_PX = 4;
  const MAX_INDENT_PX = 64;

  const PREF_AUTO_NEST = "mod.nestedtabs.auto_nest";
  const PREF_CLOSE_BEHAVIOR = "mod.nestedtabs.close_behavior";
  const PREF_INDENT = "mod.nestedtabs.indent";
  const PREF_CARET_POSITION = "mod.nestedtabs.caret_position";
  const PREF_TREE_LINES = "mod.nestedtabs.tree_lines";
  const PREF_INTERACTIVE_LINES = "mod.nestedtabs.interactive_lines";
  const PREF_SHOW_GUIDES_OLD = "mod.nestedtabs.show_guides";

  /** Start edge of a line under the icon of the depth-`column` ancestor, from the row's start. */
  const columnX = column => `calc(${column} * var(--nt-indent) + var(--nt-trunk-x) - var(--nt-connector-width) / 2)`;

  /** A background-position `x` from the row's inline start and `y` from the top. */
  const layerPosition = (x, y, rtl) => (rtl ? `right ${x} top ${y}` : `${x} ${y}`);

  /** A full-height vertical line in indent column `column` (│). */
  const railLayer = (column, rtl) =>
    `var(--nt-rail-image) ${layerPosition(columnX(column), "0px", rtl)} / var(--nt-connector-width) 100% no-repeat`;

  /**
   * The row's own branch in its last indent column: the line down from the
   * row above, the arc and the line into the tab. `continues` keeps the
   * vertical line going to the row below (├ instead of ╰).
   */
  const branchLayers = (column, continues, rtl) => [
    `${continues ? "var(--nt-rail-image)" : "var(--nt-rail-top-image)"} ` +
      `${layerPosition(columnX(column), "0px", rtl)} / var(--nt-connector-width) 100% no-repeat`,
    `${rtl ? "var(--nt-arc-image-rtl)" : "var(--nt-arc-image)"} ` +
      `${layerPosition(columnX(column), "var(--nt-arc-y)", rtl)} / var(--nt-arc-size) var(--nt-arc-size) no-repeat`,
    "var(--nt-rail-image) " +
      layerPosition(`calc(${column} * var(--nt-indent) + var(--nt-trunk-x) + var(--nt-connector-radius))`, "50%", rtl) +
      " / var(--nt-branch-length) var(--nt-connector-width) no-repeat",
  ];

  /**
   * Where the caret sits:
   *   "icon"  (default) in place of the favicon, on hover and while
   *           collapsed, like the chevron of a space's pinned tabs
   *   "edge"  far right, after the close button, so the close button
   *           appearing on hover never slides into the caret's spot
   *   "right" after the title, before the close button
   *   "left"  before the favicon
   */
  const CARET_POSITIONS = ["icon", "edge", "right", "left"];
  const readCaretPosition = () => {
    const value = Services.prefs.getStringPref(PREF_CARET_POSITION, "icon");
    return CARET_POSITIONS.includes(value) ? value : "icon";
  };

  /**
   * Indent per level in px. Mod managers may store this text setting as a
   * string ("16", "16px") or, when it looks numeric, as an integer pref.
   */
  const readIndent = () => {
    let raw;
    try {
      switch (Services.prefs.getPrefType(PREF_INDENT)) {
        case Services.prefs.PREF_INT:
          raw = Services.prefs.getIntPref(PREF_INDENT);
          break;
        case Services.prefs.PREF_STRING:
          raw = Services.prefs.getStringPref(PREF_INDENT);
          break;
      }
    } catch (e) {}
    const px = parseFloat(raw);
    if (!Number.isFinite(px)) {
      return DEFAULT_INDENT_PX;
    }
    return Math.min(MAX_INDENT_PX, Math.max(MIN_INDENT_PX, Math.round(px)));
  };

  const KEY_ID = "zenNestedTabsId";
  const KEY_PARENT = "zenNestedTabsParent";
  const KEY_COLLAPSED = "zenNestedTabsCollapsed";
  const KEY_PROMOTIONS = "zenNestedTabsPromotions";
  const KEY_CLOSED_WITH = "zenNestedTabsClosedWith";

  // browser.xhtml already exposes SessionStore as a window global. The module
  // moved from resource:///modules/ to moz-src:/// in newer Firefox, so only
  // import it ourselves as a fallback.
  const lazy = {};
  ChromeUtils.defineLazyGetter(lazy, "SessionStore", () => {
    if (window.SessionStore) {
      return window.SessionStore;
    }
    for (const url of [
      "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
      "resource:///modules/sessionstore/SessionStore.sys.mjs",
    ]) {
      try {
        return ChromeUtils.importESModule(url).SessionStore;
      } catch (e) {}
    }
    throw new Error("[Zen Nested Tabs] SessionStore module not found");
  });

  const newId = () => Services.uuid.generateUUID().toString().slice(1, -1);

  // Grabbing a tab by its title text makes the label's text node the dragstart target.
  const targetElement = event =>
    event.target?.nodeType === Node.TEXT_NODE ? event.target.parentElement : event.target;

  /** Parse a KEY_CLOSED_WITH value: { root, order } or null. */
  const parseClosedWith = value => {
    try {
      return value ? JSON.parse(value) : null;
    } catch (e) {
      return null;
    }
  };

  class ZenNestedTabs {
    /** Extra px Zen's getSidebarMinWidth() should add for the current nesting. */
    #extraMinWidth = 0;
    /** >0 while we are moving tabs ourselves; TabMove handling is skipped. */
    #internalMoves = 0;
    #initialized = false;
    #normalizeQueued = false;
    #indentPx = DEFAULT_INDENT_PX;
    #caretPosition = "icon";
    /** Active tab drag, see #onDragStart. */
    #drag = null;
    #dropOverlay = null;
    /** Running collapse/expand animations, see #animateFold. */
    #foldAnimations = new WeakMap();
    /** Parent whose connector is under the pointer, see #onLineHover. */
    #hoverLine = null;
    /** The last normalize() pass's per-tab tree info, for redrawing lines alone. */
    #lastInfo = null;
    #linesQueued = false;

    async init() {
      // Mod managers don't reliably apply preferences.json defaults, and the
      // CSS -moz-pref() queries treat a missing pref as false.
      const defaults = Services.prefs.getDefaultBranch("");
      defaults.setBoolPref(PREF_AUTO_NEST, true);
      defaults.setStringPref(PREF_TREE_LINES, "connectors");
      defaults.setBoolPref("mod.nestedtabs.show_count", false);
      defaults.setStringPref(PREF_CLOSE_BEHAVIOR, "close_collapsed");
      defaults.setStringPref(PREF_CARET_POSITION, "icon");
      defaults.setBoolPref(PREF_INTERACTIVE_LINES, true);
      this.#migrateShowGuides();

      await this.#whenDelayedStartupFinished();
      await window.gZenWorkspaces?.promiseInitialized;
      await lazy.SessionStore.promiseAllWindowsRestored;

      for (const tab of gBrowser.tabs) {
        this.#loadFromSession(tab);
      }

      this.#applyIndent();
      this.#applyCaretPosition();
      this.#patchSidebarMinWidth();
      this.#addListeners();
      this.#addContextMenu();

      this.#initialized = true;
      this.normalize();
    }

    // -- Startup helpers -----------------------------------------------------

    #whenDelayedStartupFinished() {
      if (window.gBrowserInit?.delayedStartupFinished) {
        return Promise.resolve();
      }
      return new Promise(resolve => {
        const observer = subject => {
          if (subject === window) {
            Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
            resolve();
          }
        };
        Services.obs.addObserver(observer, "browser-delayed-startup-finished");
      });
    }

    #loadFromSession(tab) {
      const ss = lazy.SessionStore;
      tab._ntId = ss.getCustomTabValue(tab, KEY_ID) || tab._ntId || newId();
      tab._ntParentId = ss.getCustomTabValue(tab, KEY_PARENT) || null;
      tab._ntCollapsed = ss.getCustomTabValue(tab, KEY_COLLAPSED) === "true";
      try {
        tab._ntPromotions = JSON.parse(ss.getCustomTabValue(tab, KEY_PROMOTIONS) || "[]");
      } catch (e) {
        tab._ntPromotions = [];
      }
      ss.setCustomTabValue(tab, KEY_ID, tab._ntId);
    }

    #save(tab) {
      // A closing tab's values are shared with its closed-tab (undo) data.
      if (tab.closing) {
        return;
      }
      const ss = lazy.SessionStore;
      try {
        tab._ntId ??= newId();
        ss.setCustomTabValue(tab, KEY_ID, tab._ntId);
        if (tab._ntParentId) {
          ss.setCustomTabValue(tab, KEY_PARENT, tab._ntParentId);
        } else {
          ss.deleteCustomTabValue(tab, KEY_PARENT);
        }
        if (tab._ntCollapsed) {
          ss.setCustomTabValue(tab, KEY_COLLAPSED, "true");
        } else {
          ss.deleteCustomTabValue(tab, KEY_COLLAPSED);
        }
        if (tab._ntPromotions?.length) {
          ss.setCustomTabValue(tab, KEY_PROMOTIONS, JSON.stringify(tab._ntPromotions));
        } else {
          ss.deleteCustomTabValue(tab, KEY_PROMOTIONS);
        }
        tab._ntPersisted = true;
      } catch (e) {
        // Tabs that are closing or not yet registered with SessionStore throw.
      }
    }

    // -- Tree queries ----------------------------------------------------------

    isEligible(tab) {
      return (
        !!tab &&
        tab.isConnected &&
        !tab.closing &&
        !tab.hasAttribute("zen-essential") &&
        !tab.hasAttribute("zen-glance-tab") &&
        !tab.hasAttribute("zen-empty-tab")
      );
    }

    #idMap() {
      const map = new Map();
      for (const t of gBrowser.tabs) {
        if (t._ntId) {
          map.set(t._ntId, t);
        }
      }
      return map;
    }

    parentOf(tab, map = null) {
      if (!tab?._ntParentId) {
        return null;
      }
      return (map || this.#idMap()).get(tab._ntParentId) || null;
    }

    /**
     * Eligible tabs in the same container as `tab`, in sidebar order. `tab`
     * itself is always included, even while it is closing.
     */
    #siblingsInContainer(tab) {
      const container = tab.parentNode;
      return gBrowser.tabs.filter(t => t === tab || (t.parentNode === container && this.isEligible(t)));
    }

    #isAncestor(maybeAncestor, tab, map = this.#idMap()) {
      let p = this.parentOf(tab, map);
      for (let guard = 0; p && guard < 1000; guard++) {
        if (p === maybeAncestor) {
          return true;
        }
        p = this.parentOf(p, map);
      }
      return false;
    }

    /**
     * The tab's descendants in sidebar order. Uses parent pointers rather than
     * rendered depth, so it is correct mid-move and for brand new tabs.
     */
    descendantsOf(tab) {
      const map = this.#idMap();
      return this.#siblingsInContainer(tab).filter(t => t !== tab && this.#isAncestor(tab, t, map));
    }

    childrenOf(tab) {
      return this.#siblingsInContainer(tab).filter(t => t !== tab && t._ntParentId === tab._ntId);
    }

    // -- Mutations --------------------------------------------------------------

    /**
     * `promotions` is the stack of { from, to } parent ids recorded when this
     * tab was moved up because its parent closed; any other move clears it.
     */
    setParent(tab, parent, promotions = []) {
      if (parent && (parent === tab || this.#isAncestor(tab, parent))) {
        return; // would create a cycle
      }
      tab._ntParentId = parent ? parent._ntId : null;
      tab._ntPromotions = promotions;
      this.#save(tab);
    }

    setCollapsed(tab, collapsed) {
      if (!!tab._ntCollapsed === !!collapsed) {
        return;
      }
      tab._ntCollapsed = !!collapsed;
      this.#save(tab);
    }

    toggleCollapsed(tab, { recursive = false } = {}) {
      const collapse = !tab._ntCollapsed;
      this.setCollapsed(tab, collapse);
      if (recursive) {
        for (const d of this.descendantsOf(tab)) {
          if (this.childrenOf(d).length) {
            this.setCollapsed(d, collapse);
          }
        }
      }
      this.normalize();
    }

    #expandAncestors(tab) {
      const map = this.#idMap();
      for (let p = this.parentOf(tab, map), guard = 0; p && guard < 1000; p = this.parentOf(p, map), guard++) {
        this.setCollapsed(p, false);
      }
    }

    /** Move `tab` to directly after `target`, without triggering our TabMove logic. */
    #moveAfter(tab, target) {
      if (tab === target || tab.previousElementSibling === target) {
        return;
      }
      this.#internalMoves++;
      try {
        if (typeof gBrowser.moveTabAfter === "function") {
          gBrowser.moveTabAfter(tab, target);
        } else {
          let index = target._tPos;
          if (tab._tPos > index) {
            index++;
          }
          gBrowser.moveTabTo(tab, { tabIndex: index });
        }
      } catch (e) {
        console.error("[Zen Nested Tabs] move failed", e);
      } finally {
        this.#internalMoves--;
      }
    }

    /** Move `tab` to directly before `target`, without triggering our TabMove logic. */
    #moveBefore(tab, target) {
      if (tab === target || tab.nextElementSibling === target) {
        return;
      }
      this.#internalMoves++;
      try {
        if (typeof gBrowser.moveTabBefore === "function") {
          gBrowser.moveTabBefore(tab, target);
        } else {
          let index = target._tPos;
          if (tab._tPos < index) {
            index--;
          }
          gBrowser.moveTabTo(tab, { tabIndex: index });
        }
      } catch (e) {
        console.error("[Zen Nested Tabs] move failed", e);
      } finally {
        this.#internalMoves--;
      }
    }

    /** Keep `tab`'s subtree (`descendants`, in order) directly below it. */
    #bringDescendants(tab, descendants) {
      let anchor = tab;
      for (const d of descendants) {
        if (d.parentNode === tab.parentNode) {
          this.#moveAfter(d, anchor);
          anchor = d;
        }
      }
    }

    /**
     * The core tree operation: make `tab`, with its whole subtree, a child of
     * `parent` (null = top level), placed directly after `after` in sidebar
     * order (null = first in its list). Every structural change (drag and
     * drop, nest, un-nest, auto-nesting new tabs) goes through here.
     */
    moveSubtree(tab, parent, after) {
      const subtree = this.descendantsOf(tab);
      if (
        (parent && (parent === tab || subtree.includes(parent) || parent.parentNode !== tab.parentNode)) ||
        (after && (after === tab || subtree.includes(after) || after.parentNode !== tab.parentNode))
      ) {
        return; // would create a cycle or cross lists
      }
      this.setParent(tab, parent);
      if (after) {
        this.#moveAfter(tab, after);
      } else {
        const first = this.#siblingsInContainer(tab).find(t => t !== tab);
        if (first) {
          this.#moveBefore(tab, first);
        }
      }
      this.#bringDescendants(tab, subtree);
      this.#expandAncestors(tab); // never drop a tab into a folded tree
      this.normalize();
    }

    /** The last tab of `tab`'s subtree in sidebar order (or `tab`), skipping `exclude`. */
    #lastDescendant(tab, exclude = new Set()) {
      return this.descendantsOf(tab).filter(t => !exclude.has(t)).at(-1) || tab;
    }

    /** Make `tab` the last child of `parent` (moving it and its subtree). */
    nestUnder(tab, parent) {
      if (!this.isEligible(tab) || !this.isEligible(parent) || tab.parentNode !== parent.parentNode) {
        return;
      }
      const subtree = new Set([tab, ...this.descendantsOf(tab)]);
      this.moveSubtree(tab, parent, this.#lastDescendant(parent, subtree));
    }

    /** Context menu: become the last child of the sibling above. */
    indent(tab) {
      const prev = this.#previousSibling(tab);
      if (prev) {
        this.nestUnder(tab, prev);
      }
    }

    /** Context menu: become the next sibling of the current parent. */
    outdent(tab) {
      const parent = this.parentOf(tab);
      if (!parent) {
        return;
      }
      const subtree = new Set([tab, ...this.descendantsOf(tab)]);
      this.moveSubtree(tab, this.parentOf(parent), this.#lastDescendant(parent, subtree));
    }

    #previousSibling(tab) {
      const list = this.#siblingsInContainer(tab);
      for (let i = list.indexOf(tab) - 1; i >= 0; i--) {
        if (list[i]._ntParentId === tab._ntParentId) {
          return list[i];
        }
        if ((list[i]._ntDepth || 0) < (tab._ntDepth || 0)) {
          return null; // reached our parent: no earlier sibling
        }
      }
      return null;
    }

    setAllCollapsed(collapsed) {
      for (const tab of gBrowser.tabs) {
        if (this.isEligible(tab) && tab.hasAttribute("nt-has-children")) {
          this.setCollapsed(tab, collapsed);
        }
      }
      this.normalize();
    }

    // -- Normalize + render ------------------------------------------------------

    /** Coalesce many structural events into one pass per frame. */
    scheduleNormalize() {
      if (this.#normalizeQueued || !this.#initialized) {
        return;
      }
      this.#normalizeQueued = true;
      requestAnimationFrame(() => {
        this.#normalizeQueued = false;
        this.normalize();
      });
    }

    /**
     * Render the tree. This only *reads* the tree: depth, hidden state and
     * child counts come from parent pointers, never from sidebar order, so a
     * tab that is momentarily out of place (closing, mid-move, just opened)
     * can't cut anyone off. The only changes made here are for tabs that have
     * really left their list (see #leaveList).
     */
    normalize() {
      if (!this.#initialized) {
        return;
      }
      this.#applyListChanges();
      this.#repairOrder();

      const map = this.#idMap();
      const activeSpace = window.gZenWorkspaces?.activeWorkspace;
      const info = new Map(); // tab -> { depth, hidden, ancestors, shown, descendants }
      let maxVisibleDepth = 0;

      for (const tab of gBrowser.tabs) {
        if (!this.isEligible(tab)) {
          this.#clearTab(tab);
          continue;
        }
        if (tab._ntPending) {
          continue; // not placed yet, see #onTabOpen
        }
        if (!tab._ntPersisted) {
          this.#save(tab);
        }
        const ancestors = this.#ancestors(tab, map);
        const outermostCollapsed = ancestors.findLastIndex(a => a._ntCollapsed);
        tab._ntRevealed = outermostCollapsed >= 0 && (tab._ntRevealed || tab.selected);
        // Revealed tabs show directly under their outermost collapsed ancestor.
        const shown = tab._ntRevealed ? ancestors.slice(outermostCollapsed) : ancestors;
        info.set(tab, {
          depth: shown.length,
          hidden: outermostCollapsed >= 0 && !tab._ntRevealed,
          ancestors,
          shown,
          descendants: 0,
        });
      }

      for (const [tab, { depth, hidden, ancestors }] of info) {
        for (const ancestor of ancestors) {
          info.get(ancestor).descendants++;
        }
        const inActiveSpace =
          !activeSpace || !tab.hasAttribute("zen-workspace-id") || tab.getAttribute("zen-workspace-id") === activeSpace;
        if (!hidden && inActiveSpace && !tab.hidden) {
          maxVisibleDepth = Math.max(maxVisibleDepth, depth);
        }
      }

      for (const [tab, { depth, hidden, descendants }] of info) {
        if (!descendants && tab._ntCollapsed) {
          tab._ntCollapsed = false;
          this.#save(tab);
        }
        tab._ntList = tab.parentNode;
        this.#renderTab(tab, depth, hidden, descendants);
      }

      this.#lastInfo = info;
      this.#renderTreeLines(info);
      this.#updateSidebarWidth(maxVisibleDepth);
      this.#updateGuideGap();
      this.#updateIconOffset();
    }

    /** A choice made with the old show_guides checkbox carries over to tree_lines. */
    #migrateShowGuides() {
      const prefs = Services.prefs;
      if (!prefs.prefHasUserValue(PREF_SHOW_GUIDES_OLD)) {
        return;
      }
      if (!prefs.prefHasUserValue(PREF_TREE_LINES) && prefs.getPrefType(PREF_SHOW_GUIDES_OLD) === prefs.PREF_BOOL) {
        prefs.setStringPref(PREF_TREE_LINES, prefs.getBoolPref(PREF_SHOW_GUIDES_OLD) ? "guides" : "off");
      }
      prefs.clearUserPref(PREF_SHOW_GUIDES_OLD);
    }

    /**
     * Sets --nt-rails on every visible tree tab: the tab's own branch in its
     * last indent column, plus a vertical line in each earlier column whose
     * tab on this tab's ancestor chain has a later visible sibling. Lines of
     * the parent whose connector is hovered go to --nt-rails-hover instead.
     * Hidden tabs keep the lines they had while folding away.
     */
    #renderTreeLines(info) {
      const lastChild = new Map(); // shown parent -> its last visible child
      for (const [tab, { hidden, shown }] of info) {
        if (!hidden && shown.length) {
          lastChild.set(shown[0], tab);
        }
      }
      const rtl = document.documentElement.matches(":-moz-locale-dir(rtl)");
      for (const [tab, { depth, hidden, shown }] of info) {
        if (hidden) {
          continue;
        }
        const chain = [tab, ...shown]; // chain[k] is at depth (depth - k)
        const rails = [];
        const hoverRails = [];
        const hits = [];
        for (let column = 0; column < depth; column++) {
          const parent = chain[depth - column];
          const own = column === depth - 1;
          const continues = lastChild.get(parent) !== chain[depth - 1 - column];
          if (!own && !continues) {
            continue;
          }
          const layers = own ? branchLayers(column, continues, rtl) : [railLayer(column, rtl)];
          (parent === this.#hoverLine ? hoverRails : rails).push(...layers);
          hits.push({ column, parent, parts: own ? [continues ? "rail" : "top", "arm"] : ["rail"] });
        }
        for (const [property, layers] of [["--nt-rails", rails], ["--nt-rails-hover", hoverRails]]) {
          const value = layers.join(", ") || "none";
          if (tab.style.getPropertyValue(property) !== value) {
            tab.style.setProperty(property, value);
          }
        }
        this.#renderHits(tab, hits);
      }
    }

    /**
     * Click targets over the row's connector lines ([nt-part] rail, top or
     * arm in indent column --nt-col), each knowing the parent its line
     * belongs to.
     */
    #renderHits(tab, hits) {
      const stack = tab.querySelector(":scope > .tab-stack");
      if (!stack) {
        return;
      }
      let box = stack.querySelector(":scope > .nt-hits");
      const key = hits.map(({ column, parent, parts }) => `${column}:${parts}:${parent._ntId}`).join(" ");
      if (!box || box._ntKey !== key) {
        box ??= stack.appendChild(Object.assign(document.createXULElement("hbox"), { className: "nt-hits" }));
        box._ntKey = key;
        box.replaceChildren(
          ...hits.flatMap(({ column, parts }) =>
            parts.map(part => {
              const hit = document.createXULElement("hbox");
              hit.className = "nt-hit";
              hit.setAttribute("nt-part", part);
              hit.style.setProperty("--nt-col", column);
              return hit;
            })
          )
        );
      }
      const parents = hits.flatMap(({ parent, parts }) => parts.map(() => parent));
      [...box.children].forEach((hit, i) => (hit._ntParent = parents[i]));
    }

    #setHoverLine(parent) {
      if (parent === this.#hoverLine) {
        return;
      }
      this.#hoverLine = parent;
      if (this.#linesQueued || !this.#lastInfo) {
        return;
      }
      this.#linesQueued = true;
      requestAnimationFrame(() => {
        this.#linesQueued = false;
        this.#renderTreeLines(this.#lastInfo);
      });
    }

    /** Sets --nt-icon-x: the center of a parent tab's icon, from the start of its row. */
    #updateIconOffset() {
      const tab = gBrowser.tabs.find(t => t.hasAttribute("nt-has-children") && !t.hasAttribute("nt-hidden") && !t.hidden);
      const stack = tab?.querySelector(".tab-stack")?.getBoundingClientRect();
      const icon = [".tab-icon-image", ".tab-icon-stack"]
        .map(selector => tab?.querySelector(selector)?.getBoundingClientRect())
        .find(rect => rect?.width);
      if (!stack?.width || !icon?.width) {
        return;
      }
      const isRTL = document.documentElement.matches(":-moz-locale-dir(rtl)");
      const center = isRTL ? stack.right - (icon.left + icon.width / 2) : icon.left + icon.width / 2 - stack.left;
      const value = `${Math.round(center * 100) / 100}px`;
      if (document.documentElement.style.getPropertyValue("--nt-icon-x") !== value) {
        document.documentElement.style.setProperty("--nt-icon-x", value);
      }
    }

    /**
     * The tab's ancestors that count for display, nearest first. A parent only
     * counts while it is a live, placed tree tab in the same list; otherwise
     * the chain stops there (without changing the stored tree).
     */
    #ancestors(tab, map) {
      const result = [];
      let current = tab;
      while (result.length < 1000) {
        const parent = this.parentOf(current, map);
        if (
          !parent ||
          parent === tab ||
          !this.isEligible(parent) ||
          parent._ntPending ||
          parent.parentNode !== tab.parentNode
        ) {
          break;
        }
        result.push(parent);
        current = parent;
      }
      return result;
    }

    /**
     * Tree operation: take `tab` out of its tree. Its children move up to its
     * parent (they stay where they are, so the tree stays contiguous) and the
     * tab itself becomes top-level.
     */
    #leaveTree(tab) {
      const grandparent = this.parentOf(tab);
      for (const child of gBrowser.tabs.filter(t => t !== tab && t._ntParentId === tab._ntId)) {
        this.setParent(child, grandparent);
      }
      this.setParent(tab, null);
    }

    /**
     * Tabs that really left their list since the last render: moved into a
     * folder, the pinned list, another space, or became an Essential / Glance.
     * Closing tabs are handled by #onTabClose instead.
     */
    #applyListChanges() {
      for (const tab of gBrowser.tabs) {
        if (tab.closing || tab._ntPending) {
          continue;
        }
        const leftList = tab._ntList && tab._ntList !== tab.parentNode;
        const leftTrees = !this.isEligible(tab) && (tab._ntParentId || gBrowser.tabs.some(t => t._ntParentId === tab._ntId));
        if (leftList || leftTrees) {
          this.#leaveTree(tab);
          tab._ntList = tab.parentNode;
          if (leftList && this.isEligible(tab)) {
            // Join whatever tree it landed in, like a drop.
            this.setParent(tab, this.#parentFromPosition(tab));
          }
        }
      }
    }

    /** The tab's parent if it is a live, placed tab in the same list, else null. */
    #liveParent(tab, map) {
      const parent = this.parentOf(tab, map);
      return parent && this.isEligible(parent) && !parent._ntPending && parent.parentNode === tab.parentNode
        ? parent
        : null;
    }

    /** Whether `tab` is `ancestor` or below it, following live parents only. */
    #inBlock(ancestor, tab, map) {
      for (let t = tab, guard = 0; t && guard < 1000; t = this.#liveParent(t, map), guard++) {
        if (t === ancestor) {
          return true;
        }
      }
      return false;
    }

    /** Whether `tab` hangs below a tab whose parent is closed or not placed yet. */
    #isFloating(tab, map) {
      let root = tab;
      for (let p = this.#liveParent(root, map), guard = 0; p && guard < 1000; p = this.#liveParent(p, map), guard++) {
        root = p;
      }
      return !!root._ntParentId;
    }

    /**
     * The first tab, in sidebar order, that sits outside its parent's block:
     * the tab above it is neither its parent nor in its parent's subtree.
     * Floating subtrees (see #isFloating) are looked through unless they are
     * the parent's own.
     */
    #findMisplaced(map) {
      const lastAny = new Map(); // list -> last placed tab
      const lastFixed = new Map(); // list -> last placed tab that is not floating
      for (const tab of gBrowser.tabs) {
        if (!this.isEligible(tab) || tab._ntPending) {
          continue;
        }
        const list = tab.parentNode;
        const parent = this.#liveParent(tab, map);
        const prev = lastAny.get(list);
        const placed =
          this.#inBlock(parent, prev, map) ||
          (prev && this.#isFloating(prev, map) && this.#inBlock(parent, lastFixed.get(list), map));
        if (parent && !placed) {
          return { tab, parent };
        }
        lastAny.set(list, tab);
        if (!this.#isFloating(tab, map)) {
          lastFixed.set(list, tab);
        }
      }
      return null;
    }

    /** Move every misplaced tab, with its subtree, to the end of its parent's block. */
    #repairOrder() {
      const map = this.#idMap();
      for (let pass = 0; pass < 200; pass++) {
        const misplaced = this.#findMisplaced(map);
        if (!misplaced) {
          return;
        }
        const { tab, parent } = misplaced;
        const subtree = this.descendantsOf(tab);
        const moving = new Set([tab, ...subtree]);
        const parentFloats = this.#isFloating(parent, map);
        const list = this.#siblingsInContainer(parent);
        let anchor = parent;
        for (const t of list.slice(list.indexOf(parent) + 1)) {
          if (moving.has(t) || t._ntPending) {
            continue;
          }
          if (this.#inBlock(parent, t, map)) {
            anchor = t;
          } else if (parentFloats || !this.#isFloating(t, map)) {
            break;
          }
        }
        this.#moveAfter(tab, anchor);
        this.#bringDescendants(tab, subtree);
      }
      console.warn("[Zen Nested Tabs] gave up repairing tab order");
    }

    #renderTab(tab, depth, hidden, descendants) {
      const fold =
        tab.hasAttribute("nt-depth") && tab.hasAttribute("nt-hidden") !== hidden && this.#canAnimateFold(tab);
      tab._ntDepth = depth;
      if (tab.getAttribute("nt-depth") !== String(depth)) {
        tab.setAttribute("nt-depth", depth);
      }
      // Compare the style too: a drag preview may have changed it.
      if (tab.style.getPropertyValue("--nt-depth") !== String(depth)) {
        tab.style.setProperty("--nt-depth", depth);
      }
      if (fold) {
        this.#animateFold(tab, hidden);
      }
      tab.toggleAttribute("nt-hidden", hidden);
      tab.toggleAttribute("nt-has-children", descendants > 0);
      tab.toggleAttribute("nt-collapsed", descendants > 0 && !!tab._ntCollapsed);

      if (descendants > 0) {
        const { twisty, count } = this.#ensureDecorations(tab);
        count.textContent = descendants;
        twisty.setAttribute("aria-label", tab._ntCollapsed ? "Expand tree" : "Collapse tree");
        twisty.setAttribute("aria-expanded", String(!tab._ntCollapsed));
      }
    }

    #canAnimateFold(tab) {
      return (
        this.#initialized &&
        !tab.hidden &&
        window.gNavToolbox.getAttribute("zen-sidebar-expanded") === "true" &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    }

    /**
     * Folds `tab` out of view (`hide`) or back in, like Zen's folders: height,
     * block margins/padding and opacity over 0.18s, ease-in-out. The row stays
     * displayed ([nt-folding]) until the animation ends. A running fold is
     * reversed from its current values.
     */
    #animateFold(tab, hide) {
      const running = this.#foldAnimations.get(tab);
      const current = running ? this.#foldFrame(tab) : null;
      running?.cancel();
      tab.setAttribute("nt-folding", "");

      const shown = this.#foldFrame(tab);
      const folded = { ...shown, height: "0px", opacity: "0" };
      for (const side of ["marginTop", "marginBottom", "paddingTop", "paddingBottom"]) {
        folded[side] = "0px";
      }
      const animation = tab.animate([current ?? (hide ? shown : folded), hide ? folded : shown], {
        duration: 180,
        easing: "ease-in-out",
        fill: "forwards",
      });
      this.#foldAnimations.set(tab, animation);
      animation.finished.then(
        () => {
          if (this.#foldAnimations.get(tab) === animation) {
            this.#endFold(tab);
          }
        },
        () => {}
      );
    }

    /** The values #animateFold animates, as `tab` currently renders them. */
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
      const animation = this.#foldAnimations.get(tab);
      this.#foldAnimations.delete(tab);
      tab.removeAttribute("nt-folding");
      animation?.cancel();
    }

    #clearTab(tab) {
      if (this.#foldAnimations.has(tab)) {
        this.#endFold(tab);
      }
      tab._ntDepth = 0;
      tab._ntRevealed = false;
      if (this.#hoverLine === tab) {
        this.#hoverLine = null;
      }
      for (const attr of ["nt-depth", "nt-hidden", "nt-has-children", "nt-collapsed"]) {
        tab.removeAttribute(attr);
      }
      tab.style.removeProperty("--nt-depth");
      tab.style.removeProperty("--nt-rails");
      tab.style.removeProperty("--nt-rails-hover");
    }

    #ensureDecorations(tab) {
      const content = tab.querySelector(".tab-content");
      let twisty = content.querySelector(":scope > .nt-twisty, :scope > .tab-icon-stack > .nt-twisty");
      let count = content.querySelector(":scope > .nt-count");
      if (!count) {
        count = document.createXULElement("hbox");
        count.className = "nt-count";
        const labelContainer = content.querySelector(".tab-label-container");
        if (labelContainer) {
          labelContainer.after(count);
        } else {
          content.append(count);
        }
      }
      if (!twisty) {
        twisty = document.createXULElement("hbox");
        twisty.className = "nt-twisty";
        twisty.setAttribute("role", "button");
      }
      // See readCaretPosition(). Only touch the DOM when it is out of place.
      const iconStack = content.querySelector(".tab-icon-stack");
      if (this.#caretPosition === "icon" && iconStack) {
        if (twisty.parentNode !== iconStack) {
          iconStack.append(twisty);
        }
      } else if (this.#caretPosition === "left") {
        if (content.firstElementChild !== twisty) {
          content.prepend(twisty);
        }
      } else if (this.#caretPosition === "edge") {
        if (content.lastElementChild !== twisty) {
          content.append(twisty);
        }
      } else if (count.nextElementSibling !== twisty) {
        count.after(twisty);
      }
      return { twisty, count };
    }

    /**
     * Guide lines are drawn per row, on each tab's .tab-stack. To join up
     * without overlapping (the line is translucent, so overlaps show as darker
     * joints) each segment extends by exactly half the gap between rows.
     */
    #updateGuideGap() {
      // Any two adjacent visible rows will do; take the first nested one.
      const tab = gBrowser.tabs.find(
        t =>
          t.getAttribute("nt-depth") > 0 &&
          !t.hasAttribute("nt-hidden") &&
          t.previousElementSibling?.classList?.contains("tabbrowser-tab") &&
          !t.previousElementSibling.hasAttribute("nt-hidden")
      );
      const above = tab?.previousElementSibling.querySelector(".tab-stack")?.getBoundingClientRect();
      const below = tab?.querySelector(".tab-stack")?.getBoundingClientRect();
      if (!above?.height || !below?.height) {
        return;
      }
      const halfGap = Math.max(0, below.top - above.bottom) / 2;
      const value = `${Math.round(halfGap * 100) / 100}px`;
      if (document.documentElement.style.getPropertyValue("--nt-guide-overhang") !== value) {
        document.documentElement.style.setProperty("--nt-guide-overhang", value);
      }
    }

    // -- Sidebar width ----------------------------------------------------------

    /**
     * Zen's own resizer and _updateMaxWidth() both ask
     * gZenVerticalTabsManager.getSidebarMinWidth() for the minimum width, so we
     * wrap it and add one indent per visible nesting level.
     */
    #patchSidebarMinWidth() {
      const manager = window.gZenVerticalTabsManager;
      if (!manager || manager._ntPatched || typeof manager.getSidebarMinWidth !== "function") {
        return;
      }
      const original = manager.getSidebarMinWidth;
      const self = this;
      manager.getSidebarMinWidth = function (...args) {
        return original.apply(this, args) + self.#extraMinWidth;
      };
      manager._ntPatched = true;
    }

    #updateSidebarWidth(maxDepth) {
      const extra = maxDepth * this.#indentPx;
      const manager = window.gZenVerticalTabsManager;
      const toolbox = window.gNavToolbox;
      if (!manager || !toolbox) {
        return;
      }

      if (extra !== this.#extraMinWidth) {
        this.#extraMinWidth = extra;
        // Re-publishes --zen-toolbox-min-width for CSS and the drag resizer.
        if (typeof manager._updateMaxWidth === "function") {
          manager._updateMaxWidth();
        } else {
          toolbox.style.setProperty("--zen-toolbox-min-width", `${manager.getSidebarMinWidth()}px`);
        }
      }

      if (toolbox.getAttribute("zen-sidebar-expanded") !== "true") {
        return;
      }

      // Grow only. When nesting shrinks the minimum drops, but we leave the
      // user's current width alone.
      const maxWidth = parseFloat(toolbox.style.maxWidth);
      let required = manager.getSidebarMinWidth();
      if (Number.isFinite(maxWidth)) {
        required = Math.min(required, maxWidth);
      }
      const current = parseFloat(toolbox.getAttribute("width")) || toolbox.getBoundingClientRect().width;
      if (current < required) {
        const value = `${Math.round(required)}px`;
        toolbox.style.width = value;
        toolbox.style.setProperty("--zen-sidebar-width", value);
        toolbox.setAttribute("width", value);
        window.dispatchEvent(new Event("resize"));
      }
    }

    // -- Events -----------------------------------------------------------------

    /** Publish the indent for chrome.css; the width math uses #indentPx. */
    /** Publish the caret side for chrome.css; #ensureDecorations places it. */
    #applyCaretPosition() {
      this.#caretPosition = readCaretPosition();
      document.documentElement.setAttribute("nt-caret", this.#caretPosition);
    }

    #applyIndent() {
      this.#indentPx = readIndent();
      document.documentElement.style.setProperty("--nt-indent", `${this.#indentPx}px`);
    }

    #addListeners() {
      // Live-update when the setting changes; no restart needed.
      const indentObserver = () => {
        this.#applyIndent();
        this.normalize();
      };
      const caretObserver = () => {
        this.#applyCaretPosition();
        this.normalize(); // re-places every caret
      };
      Services.prefs.addObserver(PREF_INDENT, indentObserver);
      Services.prefs.addObserver(PREF_CARET_POSITION, caretObserver);
      window.addEventListener(
        "unload",
        () => {
          Services.prefs.removeObserver(PREF_INDENT, indentObserver);
          Services.prefs.removeObserver(PREF_CARET_POSITION, caretObserver);
        },
        { once: true }
      );

      const container = gBrowser.tabContainer;
      container.addEventListener("TabOpen", this);
      container.addEventListener("TabClose", this);
      container.addEventListener("TabMove", this);
      container.addEventListener("TabSelect", this);
      container.addEventListener("TabPinned", this);
      container.addEventListener("TabUnpinned", this);
      container.addEventListener("SSTabRestoring", this);
      container.addEventListener("TabGrouped", this);
      container.addEventListener("TabUngrouped", this);

      // Capture so the caret wins before the tab's own select/drag handlers.
      for (const type of ["mousedown", "mouseup", "click", "auxclick", "dblclick", "dragstart"]) {
        container.addEventListener(type, this, true);
      }
      container.addEventListener("mouseover", this);
      container.addEventListener("mouseleave", this);

      // Drag and drop within a list (see "Drag and drop" below). Capture on the
      // window so we see the events before Zen/Firefox's tab strip does.
      for (const type of ["dragover", "drop", "dragend"]) {
        window.addEventListener(type, this, true);
      }

      window.addEventListener("ZenWorkspacesUIUpdate", this);
      window.addEventListener("ZenWorkspaceDataChanged", this);

      // Zen toggles this attribute when expanding/collapsing the sidebar.
      new MutationObserver(() => this.scheduleNormalize()).observe(window.gNavToolbox, {
        attributes: true,
        attributeFilter: ["zen-sidebar-expanded"],
      });
    }

    handleEvent(event) {
      switch (event.type) {
        case "mousedown":
        case "mouseup":
        case "click":
        case "auxclick":
        case "dblclick":
          this.#onTreeControlEvent(event);
          break;
        case "mouseover":
        case "mouseleave":
          this.#onLineHover(event);
          break;
        case "dragstart":
          this.#onTreeControlEvent(event);
          if (!event.defaultPrevented) {
            this.#onDragStart(event);
          }
          break;
        case "dragover":
          this.#onDragOver(event);
          break;
        case "drop":
          this.#onDrop(event);
          break;
        case "dragend":
          this.#onDragEnd();
          break;
        case "TabOpen":
          this.#onTabOpen(event.target);
          break;
        case "TabClose":
          this.#onTabClose(event.target);
          break;
        case "TabMove":
          this.#onTabMove(event.target);
          break;
        case "TabSelect":
          this.scheduleNormalize();
          break;
        case "SSTabRestoring":
          this.#onTabRestoring(event.target);
          break;
        default:
          this.scheduleNormalize();
      }
    }

    #onTreeControlEvent(event) {
      const target = targetElement(event);
      const hit = target?.closest?.(".nt-hit");
      const twisty = hit ? null : target?.closest?.(".nt-twisty");
      if (!hit && !twisty) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      if (event.type === "click" && event.button === 0) {
        const tab = hit ? hit._ntParent : twisty.closest(".tabbrowser-tab");
        if (hit) {
          this.#setHoverLine(null);
        }
        if (tab?.isConnected) {
          this.toggleCollapsed(tab, { recursive: event.ctrlKey || event.metaKey });
        }
      }
    }

    #onLineHover(event) {
      const hit = event.type === "mouseover" ? targetElement(event)?.closest?.(".nt-hit") : null;
      this.#setHoverLine(hit?._ntParent ?? null);
    }

    #onTabOpen(tab) {
      tab._ntId ??= newId();
      tab._ntParentId = null;
      tab._ntCollapsed = false;
      tab._ntPromotions = [];
      this.#save(tab);

      // Only real "opened from this page" relations. `tab.owner` is also set
      // for Ctrl+T, which TST does not nest either.
      const opener = Services.prefs.getBoolPref(PREF_AUTO_NEST, true) ? tab.openerTab : null;

      // Until it is placed, a new tab may sit between a parent and its
      // children (Firefox/Zen often insert related tabs right after the
      // opener). Mark it pending so #normalize() looks through it instead of
      // treating it as a break in the tree and detaching those children.
      tab._ntPending = true;

      // Zen places the tab into its space/section after TabOpen; wait for that.
      setTimeout(() => {
        tab._ntPending = false;
        if (!this.isEligible(tab)) {
          this.scheduleNormalize();
          return;
        }
        // SSTabRestoring only fires once history is restored, after this timeout.
        const restoredId = lazy.SessionStore.getCustomTabValue(tab, KEY_ID);
        if (restoredId && restoredId !== tab._ntId) {
          this.#onTabRestoring(tab);
          return;
        }
        if (tab._ntParentId) {
          // Restored or duplicated tab: SessionStore already gave it a parent.
          this.normalize();
        } else if (opener && this.isEligible(opener) && !tab.pinned && tab.parentNode === opener.parentNode) {
          this.nestUnder(tab, opener);
        } else {
          // Not auto-nested: take the parent implied by where it was inserted,
          // so a tab dropped into the middle of a tree never splits it.
          this.setParent(tab, this.#parentFromPosition(tab));
          this.normalize();
        }
      }, 0);
    }

    #onTabClose(tab) {
      const children = this.childrenOf(tab);
      if (!children.length) {
        this.scheduleNormalize();
        return;
      }

      const behavior = Services.prefs.getStringPref(PREF_CLOSE_BEHAVIOR, "close_collapsed");
      const closeTree = behavior === "close_all" || (behavior === "close_collapsed" && tab._ntCollapsed);

      if (closeTree) {
        const descendants = this.descendantsOf(tab);
        setTimeout(() => {
          const closing = descendants.filter(t => t.isConnected && !t.closing);
          closing.forEach((t, order) =>
            lazy.SessionStore.setCustomTabValue(t, KEY_CLOSED_WITH, JSON.stringify({ root: tab._ntId, order }))
          );
          gBrowser.removeTabs(closing);
        }, 0);
      } else {
        const grandparent = this.parentOf(tab);
        const promotion = { from: tab._ntId, to: grandparent?._ntId ?? null };
        for (const child of children) {
          this.setParent(child, grandparent, [...(child._ntPromotions || []), promotion]);
        }
      }
      this.scheduleNormalize();
    }

    #onTabRestoring(tab) {
      const restoredId = lazy.SessionStore.getCustomTabValue(tab, KEY_ID);
      const original = restoredId && gBrowser.tabs.find(t => t !== tab && t._ntId === restoredId);
      this.#loadFromSession(tab);

      if (original) {
        // Duplicated tab: give it its own identity, make it a sibling of the
        // original and keep the original's subtree intact by moving the copy
        // below it.
        tab._ntId = newId();
        tab._ntParentId = original._ntParentId;
        tab._ntCollapsed = false;
        tab._ntPromotions = [];
        this.#save(tab);
        if (tab.parentNode === original.parentNode) {
          this.#moveAfter(tab, this.descendantsOf(original).at(-1) || original);
        }
      } else {
        this.#reclaimPromotedChildren(tab);
        this.#restoreClosedTree(tab);
      }
      this.scheduleNormalize();
    }

    /**
     * Undo the promotion done by #onTabClose: tabs that were moved up when
     * `tab` closed, and have not been moved since, become its children again.
     */
    #reclaimPromotedChildren(tab) {
      const reclaimed = gBrowser.tabs.filter(t => {
        const last = t._ntPromotions?.at(-1);
        return (
          last?.from === tab._ntId &&
          last.to === (tab._ntParentId ?? null) &&
          t._ntParentId === last.to &&
          t.parentNode === tab.parentNode &&
          this.isEligible(t)
        );
      });
      if (!reclaimed.length) {
        return;
      }
      for (const child of reclaimed) {
        this.setParent(child, tab, child._ntPromotions.slice(0, -1));
      }
      this.#bringDescendants(tab, this.descendantsOf(tab));
    }

    /**
     * Undo a "close the whole tree" in one step: when `tab` is the root or a
     * member of a tree closed by #onTabClose, reopen the rest of that tree and
     * put the members back under the root in their original order.
     */
    #restoreClosedTree(tab) {
      const ss = lazy.SessionStore;
      const rootId = parseClosedWith(ss.getCustomTabValue(tab, KEY_CLOSED_WITH))?.root ?? tab._ntId;
      if (!rootId) {
        return;
      }
      const inTree = extData => extData[KEY_ID] === rootId || parseClosedWith(extData[KEY_CLOSED_WITH])?.root === rootId;

      const closed = ss.getClosedTabDataForWindow(window).filter(c => inTree(c.state?.extData || {}));
      for (const c of closed) {
        ss.undoCloseById(c.closedId, true, window);
      }

      const root = gBrowser.tabs.find(t => ss.getCustomTabValue(t, KEY_ID) === rootId);
      const members = gBrowser.tabs
        .map(t => ({ t, tag: parseClosedWith(ss.getCustomTabValue(t, KEY_CLOSED_WITH)) }))
        .filter(({ tag }) => tag?.root === rootId)
        .sort((a, b) => a.tag.order - b.tag.order)
        .map(({ t }) => t);
      if (!root || !members.length) {
        return;
      }
      let anchor = root;
      for (const member of members) {
        ss.deleteCustomTabValue(member, KEY_CLOSED_WITH);
        if (member.parentNode === root.parentNode) {
          this.#moveAfter(member, anchor);
          anchor = member;
        }
      }
      if (closed.length) {
        gBrowser.selectedTab = root;
      }
      this.scheduleNormalize();
    }

    /**
     * A tab was moved by something other than us: keyboard shortcuts, Zen
     * (e.g. a drag to another list), or another add-on. Drags within a list
     * are handled by our own drag and drop and never get here. Like TST, its
     * new parent comes from where it landed, and its subtree follows it.
     */
    #onTabMove(tab) {
      if (this.#internalMoves || !this.#initialized || !this.isEligible(tab) || tab._ntPending) {
        return;
      }

      if (tab._ntList && tab._ntList !== tab.parentNode) {
        // Moved to another list (folder, pinned, space): its children stay
        // behind under its old parent, and it joins the tree where it landed.
        this.#leaveTree(tab);
        tab._ntList = tab.parentNode;
        this.setParent(tab, this.#parentFromPosition(tab));
        this.scheduleNormalize();
        return;
      }

      // Use the tree as it was before the move to find the subtree.
      const map = this.#idMap();
      const subtree = new Set();
      for (const t of gBrowser.tabs) {
        if (t !== tab && this.#isAncestor(tab, t, map)) {
          subtree.add(t);
        }
      }

      const { prev, next } = this.#neighbors(tab, subtree);
      const newParent = this.#positionalParent(prev, next, map);
      this.setParent(tab, newParent);
      if (newParent) {
        this.#expandAncestors(tab);
      }

      const ordered = gBrowser.tabs.filter(t => subtree.has(t));
      this.#bringDescendants(tab, ordered);
      this.scheduleNormalize();
    }

    /** Previous/next eligible tabs around `tab` in its container, skipping `exclude`. */
    #neighbors(tab, exclude = new Set()) {
      const list = this.#siblingsInContainer(tab).filter(t => t === tab || (!exclude.has(t) && !t._ntPending));
      const index = list.indexOf(tab);
      return { prev: list[index - 1] || null, next: list[index + 1] || null };
    }

    /** The parent implied by `tab`'s current position (see #positionalParent). */
    #parentFromPosition(tab, exclude = new Set(), map = this.#idMap()) {
      const { prev, next } = this.#neighbors(tab, exclude);
      return this.#positionalParent(prev, next, map);
    }

    /**
     * TST's drop rule: a tab placed between `prev` and `next` joins the level
     * of `next` when `next` is nested under `prev` or one of its ancestors;
     * otherwise it is top-level.
     */
    #positionalParent(prev, next, map) {
      if (!prev || !next?._ntParentId) {
        return null;
      }
      const nextParent = this.parentOf(next, map);
      if (!nextParent || (nextParent !== prev && !this.#isAncestor(nextParent, prev, map))) {
        return null;
      }
      return nextParent;
    }

    #depthOf(tab, map) {
      let depth = 0;
      for (let p = this.parentOf(tab, map); p && depth < 1000; p = this.parentOf(p, map)) {
        depth++;
      }
      return depth;
    }

    // -- Drag and drop ------------------------------------------------------------
    //
    // While the pointer is over the dragged tab's own list, we own the drag:
    // Zen/Firefox's reordering is bypassed and the drop is one tree operation
    // (moveSubtree). The pointer picks the target:
    //   - vertical position -> the gap between two visible rows
    //   - horizontal position of the dragged tab's left edge -> the level,
    //     snapped to the nearest level that is valid in that gap
    // The indicator shows exactly that target and the drop applies it. Drags
    // that leave the list (Essentials, pinned tabs, folders, other spaces or
    // windows) are left to Zen; the tree then handles the list change.

    #onDragStart(event) {
      this.#endDrag();
      const tab = targetElement(event)?.closest?.(".tabbrowser-tab");
      if (
        !tab ||
        !this.isEligible(tab) ||
        window.gNavToolbox.getAttribute("zen-sidebar-expanded") !== "true" ||
        (tab.multiselected && gBrowser.selectedTabs.length > 1)
      ) {
        return; // multi-tab drags and the icon-only sidebar keep Zen's handling
      }
      this.#drag = {
        tab,
        list: tab.parentNode,
        subtree: new Set(this.descendantsOf(tab)),
        // Where on the tab it was grabbed, so we know where its left edge is.
        grabOffset: event.clientX - tab.getBoundingClientRect().left,
        clientX: event.clientX,
        clientY: event.clientY,
        target: null,
        expandTimer: 0,
        expandKey: null,
      };
      for (const t of [tab, ...this.#drag.subtree]) {
        t.setAttribute("nt-drag-source", "");
      }
    }

    /** Is the pointer over the dragged tab's own list (where we own the drop)? */
    #isOverOwnList(event) {
      const list = this.#drag?.list;
      const node = targetElement(event);
      if (!list || !node?.closest) {
        return false;
      }
      const row = node.closest(".tabbrowser-tab");
      if (row) {
        return row.parentNode === list && this.isEligible(row);
      }
      if (node !== list && !list.contains(node)) {
        return false;
      }
      // Empty space in the list is ours; a folder nested inside it is Zen's.
      const folder = node.closest("zen-folder");
      return !folder || !list.contains(folder);
    }

    #onDragOver(event) {
      const drag = this.#drag;
      if (!drag) {
        return;
      }
      if (!this.#isOverOwnList(event)) {
        drag.target = null;
        this.#hideDropIndicator();
        this.#cancelAutoExpand();
        return; // Zen handles drags into other lists
      }
      event.preventDefault(); // we accept the drop here...
      event.stopPropagation(); // ...and Zen/Firefox's reordering doesn't run
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      if (event.clientX || event.clientY) {
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;
      }
      this.#autoScroll(drag);
      drag.target = this.#dropTarget(drag);
      this.#showDropIndicator(drag);
      this.#scheduleAutoExpand(drag);
    }

    #onDrop(event) {
      const drag = this.#drag;
      if (!drag || !this.#isOverOwnList(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.clientX || event.clientY) {
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;
      }
      const target = this.#dropTarget(drag);
      this.#endDrag();
      if (target) {
        this.moveSubtree(drag.tab, target.parent, target.after);
      }
    }

    #onDragEnd() {
      this.#endDrag();
    }

    #endDrag() {
      const drag = this.#drag;
      this.#drag = null;
      this.#hideDropIndicator();
      if (drag) {
        clearTimeout(drag.expandTimer);
        for (const t of [drag.tab, ...drag.subtree]) {
          t.removeAttribute("nt-drag-source");
        }
      }
    }

    /**
     * Where the dragged tab would go if dropped now:
     *   { parent, after, depth, key, y, left, right }
     * `parent` and `after` are the moveSubtree() arguments; the rest is for
     * the indicator. Returns null if there is nowhere to go.
     */
    #dropTarget(drag) {
      const map = this.#idMap();
      const indent = this.#indentPx;

      // Visible rows, without the dragged tab and its subtree.
      const rows = [];
      for (const tab of this.#siblingsInContainer(drag.tab)) {
        if (tab === drag.tab || drag.subtree.has(tab) || tab._ntPending || tab.hasAttribute("nt-hidden")) {
          continue;
        }
        const rect = tab.getBoundingClientRect();
        if (rect.height) {
          rows.push({ tab, rect, depth: this.#depthOf(tab, map) });
        }
      }
      if (!rows.length) {
        return null;
      }

      // Gap: the pointer is above the middle of `next` and below the middle of `prev`.
      let index = rows.findIndex(r => drag.clientY < r.rect.top + r.rect.height / 2);
      if (index === -1) {
        index = rows.length;
      }
      const prev = rows[index - 1] || null;
      const next = rows[index] || null;

      // Valid levels in this gap: at most a child of `prev`; at least `next`'s
      // level, so `next` keeps its parent.
      const max = prev ? prev.depth + 1 : 0;
      const min = Math.min(max, next ? next.depth : 0);

      // Level from the dragged tab's left edge, snapped to the nearest valid
      // one. Once chosen it sticks until the edge is well into another level.
      const ref = prev || next;
      const rootLeft = ref.rect.left - ref.depth * indent;
      const level = (drag.clientX - drag.grabOffset - rootLeft) / indent;
      const key = `${prev?.tab._ntId}|${next?.tab._ntId}`;
      let depth = Math.round(level);
      if (drag.target?.key === key && Math.abs(level - drag.target.depth) < 0.65) {
        depth = drag.target.depth;
      }
      depth = Math.max(min, Math.min(max, depth));

      // Tree position: the parent at that level, and the tab to insert after.
      let parent = null;
      if (depth > 0) {
        parent = prev.tab;
        for (let d = prev.depth; parent && d > depth - 1; d--) {
          parent = this.parentOf(parent, map);
        }
      }
      let after = null;
      if (prev) {
        const moving = new Set([drag.tab, ...drag.subtree]);
        after = depth === prev.depth + 1 ? prev.tab : this.#lastDescendant(prev.tab, moving);
      }

      let y;
      if (prev && next) {
        y = (prev.rect.bottom + next.rect.top) / 2;
      } else if (prev) {
        y = prev.rect.bottom + 2;
      } else {
        y = next.rect.top - 2;
      }
      return { parent, after, depth, key, prevTab: prev?.tab || null, y, left: rootLeft + depth * indent, right: ref.rect.right };
    }

    /** Line (with a dot where the indent starts) + label + parent highlight. */
    #showDropIndicator(drag) {
      this.#hideDropIndicator();
      const target = drag.target;
      if (!target) {
        return;
      }
      if (target.parent) {
        target.parent.setAttribute("nt-drop-parent", "");
      }
      const { line, label } = this.#ensureDropOverlay();
      line.style.left = `${target.left}px`;
      line.style.width = `${Math.max(24, target.right - target.left)}px`;
      line.style.top = `${target.y - 1}px`;
      line.hidden = false;

      const title = target.parent?.label || target.parent?.getAttribute("label") || "";
      label.textContent = target.parent
        ? `↳ Inside “${title.length > 28 ? `${title.slice(0, 27)}…` : title}”`
        : "Top level";
      label.toggleAttribute("nt-root", !target.parent);
      label.style.top = `${target.y}px`;
      label.style.left = `${target.right}px`;
      label.hidden = false;
    }

    #hideDropIndicator() {
      for (const t of document.querySelectorAll(".tabbrowser-tab[nt-drop-parent]")) {
        t.removeAttribute("nt-drop-parent");
      }
      if (this.#dropOverlay) {
        this.#dropOverlay.line.hidden = true;
        this.#dropOverlay.label.hidden = true;
      }
    }

    #ensureDropOverlay() {
      if (!this.#dropOverlay) {
        const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
        const line = html("div");
        line.id = "nt-drop-line";
        const label = html("div");
        label.id = "nt-drop-label";
        line.hidden = label.hidden = true;
        (document.body || document.documentElement).append(line, label);
        this.#dropOverlay = { line, label };
      }
      return this.#dropOverlay;
    }

    /** Hovering as a child of a collapsed tab for a moment expands it. */
    #scheduleAutoExpand(drag) {
      const prev = drag.target?.prevTab;
      const wantsInside = prev && drag.target.parent === prev && prev._ntCollapsed;
      const key = wantsInside ? prev._ntId : null;
      if (key === drag.expandKey) {
        return;
      }
      this.#cancelAutoExpand();
      drag.expandKey = key;
      if (wantsInside) {
        drag.expandTimer = setTimeout(() => {
          if (this.#drag === drag && prev.isConnected) {
            this.setCollapsed(prev, false);
            this.normalize();
          }
        }, 600);
      }
    }

    #cancelAutoExpand() {
      const drag = this.#drag;
      if (drag) {
        clearTimeout(drag.expandTimer);
        drag.expandTimer = 0;
        drag.expandKey = null;
      }
    }

    /** Scroll the tab list while dragging near its top or bottom edge. */
    #autoScroll(drag) {
      const box = drag.list.closest?.("arrowscrollbox") || gBrowser.tabContainer.arrowScrollbox;
      if (!box?.scrollByPixels || !box.getBoundingClientRect) {
        return;
      }
      const rect = box.getBoundingClientRect();
      const zone = 36;
      let dy = 0;
      if (drag.clientY < rect.top + zone) {
        dy = -Math.ceil((rect.top + zone - drag.clientY) / 3);
      } else if (drag.clientY > rect.bottom - zone) {
        dy = Math.ceil((drag.clientY - (rect.bottom - zone)) / 3);
      }
      if (dy) {
        box.scrollByPixels(dy, true);
      }
    }

    // -- Context menu -------------------------------------------------------------

    #addContextMenu() {
      const menu = document.getElementById("tabContextMenu");
      if (!menu) {
        return;
      }
      const anchor = document.getElementById("context_moveTabOptions") || menu.firstElementChild;

      const separator = document.createXULElement("menuseparator");
      separator.className = "nt-menu-separator";

      const items = [
        ["nt-ctx-indent", "Nest Under Tab Above", tab => this.indent(tab)],
        ["nt-ctx-outdent", "Move Out One Level", tab => this.outdent(tab)],
        ["nt-ctx-toggle", "Collapse Tree", tab => this.toggleCollapsed(tab)],
        ["nt-ctx-collapse-all", "Collapse All Trees", () => this.setAllCollapsed(true)],
        ["nt-ctx-expand-all", "Expand All Trees", () => this.setAllCollapsed(false)],
      ].map(([id, label, action]) => {
        const item = document.createXULElement("menuitem");
        item.id = id;
        item.setAttribute("label", label);
        item.addEventListener("command", () => {
          const tab = TabContextMenu.contextTab;
          if (tab) {
            action(tab);
          }
        });
        return item;
      });

      anchor.before(separator, ...items);

      menu.addEventListener("popupshowing", event => {
        if (event.target !== menu) {
          return;
        }
        const tab = TabContextMenu.contextTab;
        const eligible = this.isEligible(tab) && !tab.multiselected;
        const byId = id => document.getElementById(id);

        separator.hidden = !eligible;
        byId("nt-ctx-indent").hidden = !eligible || !this.#previousSibling(tab);
        byId("nt-ctx-outdent").hidden = !eligible || !tab._ntParentId;

        const isParent = eligible && tab.hasAttribute("nt-has-children");
        const toggle = byId("nt-ctx-toggle");
        toggle.hidden = !isParent;
        toggle.setAttribute("label", tab?._ntCollapsed ? "Expand Tree" : "Collapse Tree");

        const anyTrees = gBrowser.tabs.some(t => t.hasAttribute("nt-has-children"));
        byId("nt-ctx-collapse-all").hidden = !eligible || !anyTrees;
        byId("nt-ctx-expand-all").hidden = !eligible || !anyTrees;
      });
    }
  }

  window.gZenNestedTabs = new ZenNestedTabs();
  window.gZenNestedTabs.init().catch(e => console.error("[Zen Nested Tabs] init failed", e));
})();
