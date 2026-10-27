import { ancestors, positionalParent, nextRepairMove } from "./layout.mjs";

export const KEYS = {
  id: "zenTabTreesId",
  parent: "zenTabTreesParent",
  collapsed: "zenTabTreesCollapsed",
  promotions: "zenTabTreesPromotions",
  closedWith: "zenTabTreesClosedWith",
};

const MAX_REPAIR_PASSES = 200;

export const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (e) {
    return fallback;
  }
};

const enclosingFolders = element => {
  const folders = [];
  for (let el = element.parentElement; el; el = el.parentElement) {
    if (el.isZenFolder) {
      folders.unshift(el);
    }
  }
  return folders;
};

const isSplitGroup = element => !!element?.hasAttribute?.("split-view-group");

const isCollapsiblePins = element => element?.tagName === "zen-workspace-collapsible-pins";

/** Whether `element` is a folder or split view sitting in a tab list (a row nothing nests under). */
export const isFixedItem = element =>
  !!element?.isZenFolder || isSplitGroup(element) || element?.tagName === "tab-split-view-wrapper";

/** Every tab in every space, in sidebar order (allTabs() only holds the active space's). */
export const allTabs = () => gZenWorkspaces.allStoredTabs;

/** The other open browser windows. */
export const otherWindows = () =>
  [...Services.wm.getEnumerator("navigator:browser")].filter(w => w !== window && !w.closed);

/** The tab tree, stored on Zen's tabs as `_ztt*` expandos and SessionStore custom tab values. */
export class TreeModel {
  internalMoves = 0;

  load(tab) {
    tab._zttId = SessionStore.getCustomTabValue(tab, KEYS.id) || tab._zttId || crypto.randomUUID();
    tab._zttParentId = SessionStore.getCustomTabValue(tab, KEYS.parent) || null;
    tab._zttCollapsed = SessionStore.getCustomTabValue(tab, KEYS.collapsed) === "true";
    tab._zttPromotions = parseJson(SessionStore.getCustomTabValue(tab, KEYS.promotions), []);
    tab._zttList ??= tab.parentNode;
    SessionStore.setCustomTabValue(tab, KEYS.id, tab._zttId);
  }

  save(tab) {
    if (tab.closing) {
      return;
    }
    tab._zttId ??= crypto.randomUUID();
    SessionStore.setCustomTabValue(tab, KEYS.id, tab._zttId);
    const values = [
      [KEYS.parent, tab._zttParentId],
      [KEYS.collapsed, tab._zttCollapsed ? "true" : null],
      [KEYS.promotions, tab._zttPromotions?.length ? JSON.stringify(tab._zttPromotions) : null],
    ];
    for (const [key, value] of values) {
      if (value) {
        SessionStore.setCustomTabValue(tab, key, value);
      } else {
        SessionStore.deleteCustomTabValue(tab, key);
      }
    }
  }

  /** Gives `tab` fresh tree state under `parentId` (null: top level) and saves it. */
  reset(tab, parentId = null) {
    tab._zttParentId = parentId;
    tab._zttCollapsed = false;
    tab._zttPromotions = [];
    this.save(tab);
  }

  isEligible(tab) {
    return (
      !!tab &&
      tab.isConnected &&
      !tab.closing &&
      !tab.hasAttribute("zen-essential") &&
      !tab.hasAttribute("zen-glance-tab") &&
      !tab.hasAttribute("zen-empty-tab") &&
      !isSplitGroup(tab.group) &&
      !tab.splitview
    );
  }

  idMap() {
    const map = new Map();
    for (const tab of allTabs()) {
      if (tab._zttId) {
        map.set(tab._zttId, tab);
      }
    }
    return map;
  }

  parentOf(tab, map = this.idMap()) {
    return (tab?._zttParentId && map.get(tab._zttParentId)) || null;
  }

  /** Whether `tab` is an eligible tab that has been placed in the sidebar. */
  isPlaced(tab) {
    return this.isEligible(tab) && !tab._zttPending;
  }

  /** The tab's parent if it is a placed, eligible tab in the same list. */
  liveParent(tab, map) {
    const parent = this.parentOf(tab, map);
    return parent && this.isPlaced(parent) && parent.parentNode === tab.parentNode ? parent : null;
  }

  isAncestor(ancestor, tab, map = this.idMap()) {
    for (const p of ancestors(tab, t => this.parentOf(t, map))) {
      if (p === ancestor) {
        return true;
      }
    }
    return false;
  }

  /** Whether `tab`'s chain of stored parents leads back to `tab`. */
  inCycle(tab, map = this.idMap()) {
    let last = tab;
    for (const p of ancestors(tab, t => this.parentOf(t, map))) {
      last = p;
    }
    return this.parentOf(last, map) === tab;
  }

  /** Resets every tab whose parent is a tab in another window (tabs torn off into this one). */
  dropForeignTrees() {
    const local = this.idMap();
    const foreign = new Set(otherWindows().flatMap(w => (w.gZenWorkspaces?.allStoredTabs ?? []).map(t => t._zttId)));
    for (const tab of allTabs()) {
      if (tab._zttParentId && !local.has(tab._zttParentId) && foreign.has(tab._zttParentId)) {
        this.reset(tab);
      }
    }
  }

  /** Clears a stored parent of every tab whose chain of parents loops back to it. */
  breakCycles() {
    const map = this.idMap();
    for (const tab of allTabs()) {
      if (this.inCycle(tab, map)) {
        tab._zttParentId = null;
        this.save(tab);
      }
    }
  }

  /** Number of live ancestors above `tab`. */
  depthOf(tab, map = this.idMap()) {
    let depth = 0;
    for (const p of ancestors(tab, t => this.liveParent(t, map))) {
      depth++;
    }
    return depth;
  }

  /** The outermost collapsed parent among `tab` and its live ancestors, or null. */
  collapsedRoot(tab, map = this.idMap()) {
    let root = null;
    for (const t of [tab, ...ancestors(tab, x => this.liveParent(x, map))]) {
      if (t._zttCollapsed && this.childrenOf(t).length) {
        root = t;
      }
    }
    return root;
  }

  /** Eligible tabs in `tab`'s list in sidebar order, `tab` included even while closing. */
  siblingsInList(tab) {
    return allTabs().filter(t => t === tab || (t.parentNode === tab.parentNode && this.isEligible(t)));
  }

  childrenOf(tab) {
    return this.siblingsInList(tab).filter(t => t !== tab && t._zttParentId === tab._zttId);
  }

  descendantsOf(tab) {
    const map = this.idMap();
    return this.siblingsInList(tab).filter(t => t !== tab && this.isAncestor(tab, t, map));
  }

  /** `tab`'s descendants in any list, in sidebar order. */
  subtreeOf(tab) {
    const map = this.idMap();
    const tabs = allTabs();
    const order = t => t._zttOrder ?? tabs.length + tabs.indexOf(t);
    return tabs.filter(t => t !== tab && this.isAncestor(tab, t, map)).sort((a, b) => order(a) - order(b));
  }

  /** Ids of the eligible tabs around `tab` in its list, as one string. */
  neighborsKey(tab) {
    const list = this.siblingsInList(tab);
    const index = list.indexOf(tab);
    return `${list[index - 1]?._zttId}|${list[index + 1]?._zttId}`;
  }

  /** Remembers every tab's sidebar order and neighbours, as of now. */
  recordOrder() {
    const lists = new Map();
    allTabs().forEach((tab, index) => {
      tab._zttOrder = index;
      tab._zttNeighbors = null;
      if (this.isEligible(tab)) {
        if (!lists.has(tab.parentNode)) {
          lists.set(tab.parentNode, []);
        }
        lists.get(tab.parentNode).push(tab);
      }
    });
    for (const list of lists.values()) {
      list.forEach((tab, i) => (tab._zttNeighbors = `${list[i - 1]?._zttId}|${list[i + 1]?._zttId}`));
    }
  }

  /** Keeps each tab's revealed state from a computeLayout() pass over `nodes`. */
  applyLayout(nodes, layout) {
    for (const node of nodes) {
      if (node.kind === "tab") {
        node.element._zttRevealed = layout.get(node.key).revealed;
      }
    }
  }

  /** `promotions`: the { from, to } parent ids recorded when a closing parent moved this tab up. */
  setParent(tab, parent, promotions = []) {
    if (parent && (parent === tab || this.isAncestor(tab, parent))) {
      return;
    }
    tab._zttParentId = parent ? parent._zttId : null;
    tab._zttPromotions = promotions;
    this.save(tab);
  }

  setCollapsed(tab, collapsed) {
    if (!!tab._zttCollapsed === !!collapsed) {
      return;
    }
    tab._zttCollapsed = !!collapsed;
    this.save(tab);
  }

  toggleCollapsed(tab, recursive) {
    const collapse = !tab._zttCollapsed;
    this.setCollapsed(tab, collapse);
    if (recursive) {
      const descendants = this.descendantsOf(tab);
      const parents = new Set(descendants.map(d => d._zttParentId));
      for (const d of descendants) {
        if (parents.has(d._zttId)) {
          this.setCollapsed(d, collapse);
        }
      }
    }
  }

  expandAncestors(tab) {
    const map = this.idMap();
    for (const p of ancestors(tab, t => this.parentOf(t, map))) {
      this.setCollapsed(p, false);
    }
  }

  moveAfter(tab, target) {
    if (tab === target || tab.previousElementSibling === target) {
      return;
    }
    this.#move(() => gBrowser.moveTabAfter(tab, target));
  }

  moveBefore(tab, target) {
    if (tab === target || tab.nextElementSibling === target) {
      return;
    }
    this.#move(() => gBrowser.moveTabBefore(tab, target));
  }

  #move(action) {
    this.internalMoves++;
    try {
      action();
    } catch (e) {
      console.error("[Zen Tab Trees] move failed", e);
    } finally {
      this.internalMoves--;
    }
  }

  /** Keeps `descendants` (in order) directly below `tab`, within its list. */
  bringDescendants(tab, descendants) {
    let anchor = tab;
    for (const d of descendants) {
      if (d.parentNode === tab.parentNode) {
        this.moveAfter(d, anchor);
        anchor = d;
      }
    }
  }

  /**
   * Makes `tab`, with its subtree, a child of `parent` (null: top level),
   * placed directly after `after` (null: first in its list). Returns false
   * when that would create a cycle or cross lists.
   */
  moveSubtree(tab, parent, after) {
    const subtree = this.descendantsOf(tab);
    if (
      (parent && (parent === tab || subtree.includes(parent) || parent.parentNode !== tab.parentNode)) ||
      (after && (after === tab || subtree.includes(after) || after.parentNode !== tab.parentNode))
    ) {
      return false;
    }
    this.setParent(tab, parent);
    if (after) {
      this.moveAfter(tab, after);
    } else {
      const first = this.siblingsInList(tab).find(t => t !== tab);
      if (first) {
        this.moveBefore(tab, first);
      }
    }
    this.bringDescendants(tab, subtree);
    this.expandAncestors(tab);
    return true;
  }

  /** The last tab of `tab`'s subtree in sidebar order (or `tab`), skipping `exclude`. */
  lastDescendant(tab, exclude = new Set()) {
    return this.descendantsOf(tab).filter(t => !exclude.has(t)).at(-1) || tab;
  }

  nestUnder(tab, parent) {
    if (!this.isEligible(tab) || !this.isEligible(parent) || tab.parentNode !== parent.parentNode) {
      return false;
    }
    const subtree = new Set([tab, ...this.descendantsOf(tab)]);
    return this.moveSubtree(tab, parent, this.lastDescendant(parent, subtree));
  }

  /** The parent implied by `tab`'s position between its neighbours, skipping `exclude`. */
  parentFromPosition(tab, exclude = new Set()) {
    const list = this.siblingsInList(tab).filter(t => t === tab || (!exclude.has(t) && !t._zttPending));
    const index = list.indexOf(tab);
    const map = this.idMap();
    const key = positionalParent(
      list[index - 1]?._zttId ?? null,
      list[index + 1]?._zttId ?? null,
      k => map.get(k)?._zttParentId ?? null
    );
    return (key && map.get(key)) || null;
  }

  /** Takes `tab` out of its tree: its children move up to its parent, it becomes top level. */
  leaveTree(tab) {
    const grandparent = this.parentOf(tab);
    for (const child of allTabs().filter(t => t !== tab && t._zttParentId === tab._zttId)) {
      this.setParent(child, grandparent);
    }
    this.setParent(tab, null);
  }

  /** Puts `tab` into `ref`'s list: same space, pinned state and folder. Returns whether it got there. */
  moveIntoList(tab, ref) {
    this.#move(() => {
      if (ref.pinned && !tab.pinned) {
        gBrowser.pinTab(tab);
      } else if (!ref.pinned && tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      const space = ref.getAttribute("zen-workspace-id");
      if (space && tab.getAttribute("zen-workspace-id") !== space) {
        gZenWorkspaces.moveTabToWorkspace(tab, space);
      }
      const folder = enclosingFolders(ref).at(-1) ?? null;
      if (folder && tab.group !== folder) {
        folder.addTabs([tab]);
      } else if (!folder && enclosingFolders(tab).length) {
        gBrowser.ungroupTab(tab);
      }
    });
    tab._zttList = tab.parentNode;
    return tab.parentNode === ref.parentNode;
  }

  /**
   * Handles tabs that changed list since the last pass. A moved tab takes the
   * parent its new position implies and brings its subtree along; a tab that
   * left the trees (Essentials, split views) leaves its children behind.
   */
  applyListChanges() {
    const tabs = [...allTabs()];
    const map = this.idMap();
    const moved = tabs.filter(t => !t.closing && !t._zttPending && t._zttList && t._zttList !== t.parentNode);
    for (const tab of tabs) {
      if (tab.closing || tab._zttPending) {
        continue;
      }
      if (tab._zttId === undefined) {
        this.load(tab);
      }
      const isMoved = moved.includes(tab);
      if (isMoved && this.isEligible(tab)) {
        if (!moved.some(m => m !== tab && this.isAncestor(m, tab, map))) {
          const subtree = this.subtreeOf(tab);
          this.setParent(tab, this.parentFromPosition(tab, new Set(subtree)));
          this.carrySubtree(tab, subtree);
        }
      } else if (
        isMoved ||
        (!this.isEligible(tab) && (tab._zttParentId || tabs.some(t => t._zttParentId === tab._zttId)))
      ) {
        this.leaveTree(tab);
      }
      tab._zttList = tab.parentNode;
    }
  }

  /** Brings `subtree` (in order) into `tab`'s list directly below it. */
  carrySubtree(tab, subtree) {
    let anchor = tab;
    for (const d of subtree) {
      if (d.closing || !d.isConnected) {
        continue;
      }
      if (d.parentNode !== tab.parentNode) {
        this.moveIntoList(d, tab);
      }
      if (d.parentNode === tab.parentNode) {
        this.moveAfter(d, anchor);
        anchor = d;
      }
      d._zttList = d.parentNode;
    }
  }

  /** Moves every tab that sits outside its parent's block back to the end of that block. */
  repairOrder() {
    const lists = new Set(allTabs().filter(t => this.isPlaced(t)).map(t => t.parentNode));
    const map = this.idMap();
    for (const list of lists) {
      let last = null;
      for (let pass = 0; ; pass++) {
        if (pass === MAX_REPAIR_PASSES) {
          console.warn("[Zen Tab Trees] gave up repairing tab order");
          break;
        }
        const items = [];
        for (const el of list.children) {
          if (gBrowser.isTab(el)) {
            if (this.isPlaced(el)) {
              const parent = this.liveParent(el, map);
              items.push({ key: el._zttId, parent: parent?._zttId ?? null, orphan: !parent && !!el._zttParentId });
            }
          } else if (isFixedItem(el)) {
            items.push({ key: `fixed:${items.length}`, parent: null, orphan: false });
          }
        }
        const move = nextRepairMove(items);
        if (!move || (move.key === last?.key && move.anchor === last.anchor)) {
          break;
        }
        last = move;
        const tab = map.get(move.key);
        const subtree = this.descendantsOf(tab);
        this.moveAfter(tab, map.get(move.anchor));
        this.bringDescendants(tab, subtree);
      }
    }
  }

  /** Sidebar rows (tabs, folders, split views) in order, as computeLayout nodes. */
  sidebarNodes() {
    const map = this.idMap();
    const nodes = [];
    const seen = new Set();
    const folderNode = (folder, folders) => {
      const index = folders.indexOf(folder);
      return {
        key: `f:${folder.id}`,
        kind: "folder",
        parent: index > 0 ? `f:${folders[index - 1].id}` : null,
        collapsed: !!folder.collapsed,
        selected: false,
        revealed: false,
        inCollapsedFolder: folders.slice(0, index).some(f => f.collapsed),
        element: folder,
      };
    };
    for (const tab of allTabs()) {
      const folders = enclosingFolders(tab);
      for (const folder of folders) {
        if (!seen.has(folder)) {
          seen.add(folder);
          nodes.push(folderNode(folder, folders));
        }
      }
      const folderKey = folders.length ? `f:${folders.at(-1).id}` : null;
      const inCollapsedPins = isCollapsiblePins(tab.group) && !!tab.group.collapsed;
      const inCollapsedFolder = inCollapsedPins || folders.some(f => f.collapsed);
      if (isSplitGroup(tab.group)) {
        if (!seen.has(tab.group)) {
          seen.add(tab.group);
          nodes.push({
            key: `s:${tab.group.id}`,
            kind: "split",
            parent: folderKey,
            collapsed: false,
            selected: false,
            revealed: false,
            inCollapsedFolder,
            folderActive: tab.group.tabs.some(t => t.hasAttribute("folder-active")),
            element: tab.group,
          });
        }
        continue;
      }
      if (!this.isPlaced(tab)) {
        continue;
      }
      nodes.push({
        key: tab._zttId,
        kind: "tab",
        parent: this.liveParent(tab, map)?._zttId ?? folderKey,
        collapsed: !!tab._zttCollapsed,
        selected: !!tab.selected,
        revealed: !!tab._zttRevealed,
        inCollapsedFolder,
        folderActive: tab.hasAttribute("folder-active") || (inCollapsedPins && (tab.selected || !!tab.multiselected)),
        element: tab,
      });
    }
    return nodes;
  }
}
