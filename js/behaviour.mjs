import { KEYS, allTabs, otherWindows, parseJson } from "./model.mjs";

const parseClosedWith = value => parseJson(value, null);

const isSyncedWindow = win =>
  !win.gZenWorkspaces?.privateWindowOrDisabled &&
  !win.document?.documentElement?.hasAttribute?.("zen-unsynced-window");

/** Reactions to Zen and Firefox tab events that change the tree. */
export class Behaviour {
  #successor = null;

  constructor(trees) {
    this.trees = trees;
  }

  get model() {
    return this.trees.model;
  }

  onTabOpen(tab) {
    const model = this.model;
    tab._zttId ??= crypto.randomUUID();
    model.reset(tab);
    const opener = tab.openerTab;
    tab._zttPending = true;

    setTimeout(() => {
      tab._zttPending = false;
      tab._zttList = tab.parentNode;
      if (!model.isEligible(tab)) {
        this.trees.scheduleRefresh();
        return;
      }
      // SSTabRestoring arrives after this timeout; the restored values are already readable.
      const restoredId = SessionStore.getCustomTabValue(tab, KEYS.id);
      if (restoredId && restoredId !== tab._zttId) {
        this.onTabRestoring(tab);
        return;
      }
      if (!tab._zttParentId) {
        if (!opener) {
          model.setParent(tab, model.parentFromPosition(tab));
        } else if (!model.isEligible(opener)) {
          model.setParent(tab, null);
        } else {
          this.#nestUnderOpener(tab, opener);
        }
      }
      this.trees.scheduleRefresh();
    }, 0);
  }

  /** Points the selected tab's successor past its hidden subtree while it is a collapsed parent. */
  updateSuccessor() {
    const model = this.model;
    const tab = gBrowser.selectedTab;
    const descendants = tab?._zttCollapsed && model.isPlaced(tab) ? model.descendantsOf(tab) : [];
    const last = this.#successor;
    if (last && (last.tab !== tab || !descendants.length)) {
      this.releaseSuccessor();
    }
    if (!descendants.length) {
      return;
    }
    const successor = gBrowser._findTabToBlurTo?.(tab, [...descendants]);
    if (successor && tab.successor !== successor) {
      this.#successor = { tab, successor, previous: this.#successor?.previous ?? tab.successor };
      gBrowser.setSuccessor(tab, successor);
    }
  }

  /** Gives the tab whose successor the mod set its previous successor back, unless someone changed it since. */
  releaseSuccessor() {
    const last = this.#successor;
    this.#successor = null;
    if (last && last.tab.successor === last.successor) {
      gBrowser.setSuccessor(last.tab, last.previous?.isConnected ? last.previous : null);
    }
  }

  /** A Glance preview that became a full tab nests under the tab it was opened from. */
  onGlanceOpened(tab) {
    const model = this.model;
    if (!model.isEligible(tab) || !model.isEligible(tab.owner)) {
      return;
    }
    tab._zttList = tab.parentNode;
    this.#nestUnderOpener(tab, tab.owner);
    this.trees.refresh();
  }

  /** Records the pinned URL and title of a tab pinned by the opener rule once its first page has loaded. */
  onPageLoaded(tab, url) {
    if (!tab?._zttRecordPinOnLoad || url === "about:blank") {
      return;
    }
    delete tab._zttRecordPinOnLoad;
    window.gZenWindowSync
      ?.setPinnedTabState(tab)
      .then(() => gZenPinnedTabManager.resetPinChangedUrl(tab))
      .catch(e => console.error("[Zen Tab Trees] recording the pinned state failed", e));
  }

  #nestUnderOpener(tab, opener) {
    const model = this.model;
    if (tab.parentNode !== opener.parentNode) {
      const wasPinned = tab.pinned;
      model.moveIntoList(tab, opener);
      // Zen records a pinned tab's URL when it is pinned; before the link commits there is none.
      if (tab.pinned && !wasPinned && window.gZenWindowSync && tab.linkedBrowser?.currentURI?.spec === "about:blank") {
        tab._zttRecordPinOnLoad = true;
      }
    }
    if (!model.nestUnder(tab, opener)) {
      model.setParent(tab, model.parentFromPosition(tab));
    }
  }

  /** A tab moved by something else (keyboard, Zen, add-ons) joins the level its position implies; its subtree follows. */
  onTabMove(tab) {
    const model = this.model;
    if (model.internalMoves || !model.isPlaced(tab)) {
      return;
    }
    if (tab._zttList === tab.parentNode && model.neighborsKey(tab) !== tab._zttNeighbors) {
      const map = model.idMap();
      const subtree = allTabs().filter(t => t !== tab && model.isAncestor(tab, t, map));
      const moving = new Set(subtree);
      const current = model.parentOf(tab, map);
      let parent = model.parentFromPosition(tab, moving);
      if (this.#stepOverBlocks(tab, moving, map)) {
        parent = this.#keptParent(tab, moving, model.parentFromPosition(tab, moving), current, map);
      }
      model.setParent(tab, parent);
      if (parent) {
        model.expandAncestors(tab);
      }
      model.bringDescendants(tab, subtree);
    }
    this.trees.scheduleRefresh();
  }

  /**
   * Turns a one-row move (Firefox's Move Tab Forward/Backward) into a move over
   * one visible row: past the tab's own subtree, and over collapsed trees as a
   * whole. Returns whether it moved the tab.
   */
  #stepOverBlocks(tab, moving, map) {
    const model = this.model;
    const list = model.siblingsInList(tab);
    const index = list.indexOf(tab);
    const prev = list[index - 1];
    const next = list[index + 1];
    const at = allTabs().indexOf(tab);
    const forward = tab._zttOrder !== undefined && at > tab._zttOrder;
    const oneStepBack = tab._zttOrder - at === 1;
    const outside = root => root && !model.isAncestor(root, tab, map);
    const blockEnd = row => {
      const root = model.collapsedRoot(row, map);
      return outside(root) ? model.lastDescendant(root, moving) : row;
    };
    const parent = model.liveParent(tab, map);
    const own = (tab.selected || tab._zttRevealed) && parent ? model.collapsedRoot(parent, map) : null;
    const inOwn = row => !!row && (row === own || model.isAncestor(own, row, map));
    if (own && inOwn(prev)) {
      if (forward) {
        const beyond = list.slice(index + 1).find(t => !moving.has(t) && !inOwn(t));
        model.moveAfter(tab, beyond ? blockEnd(beyond) : model.lastDescendant(own, moving));
      } else {
        model.moveBefore(tab, own);
      }
      return true;
    }
    if (forward && prev && moving.has(prev)) {
      const beyond = list.slice(index + 1).find(t => !moving.has(t));
      if (beyond) {
        model.moveAfter(tab, blockEnd(beyond));
      } else {
        model.moveBefore(tab, list.find(t => moving.has(t)));
      }
      return true;
    }
    if (forward && prev && outside(model.collapsedRoot(prev, map))) {
      model.moveAfter(tab, blockEnd(prev));
      return true;
    }
    if (!forward && next && !moving.has(next)) {
      const root = model.collapsedRoot(next, map);
      if (outside(root) && root !== next) {
        if (oneStepBack) {
          model.moveBefore(tab, root);
        } else {
          model.moveAfter(tab, model.lastDescendant(root, moving));
        }
        return true;
      }
    }
    return false;
  }

  /** After a step, the tab keeps `current` as parent while it still ends that parent's block. */
  #keptParent(tab, moving, positional, current, map) {
    const model = this.model;
    const list = model.siblingsInList(tab).filter(t => t === tab || !moving.has(t));
    const prev = list[list.indexOf(tab) - 1];
    if (!current || !prev || (current !== prev && !model.isAncestor(current, prev, map))) {
      return positional;
    }
    return positional && model.isAncestor(current, positional, map) ? positional : current;
  }

  /** `detail` is the TabClose event's detail; `adoptedBy` is set when the tab moves to another window. */
  onTabClose(tab, detail) {
    const model = this.model;
    const children = model.childrenOf(tab).filter(c => !SessionStore.getCustomTabValue(c, KEYS.closedWith));
    if (children.length) {
      const grandparent = model.parentOf(tab);
      const descendants = tab._zttCollapsed ? model.descendantsOf(tab) : [];
      if (detail?.adoptedBy) {
        for (const child of children) {
          model.setParent(child, grandparent);
        }
      } else if (tab._zttCollapsed && this.#fitsRecentlyClosed(descendants) && !this.isSyncEcho(tab)) {
        setTimeout(() => {
          const closing = descendants.filter(t => t.isConnected && !t.closing);
          closing.forEach((t, order) =>
            SessionStore.setCustomTabValue(t, KEYS.closedWith, JSON.stringify({ root: tab._zttId, order }))
          );
          gBrowser.removeTabs(closing);
          for (const t of closing.filter(t => t.isConnected && !t.closing)) {
            SessionStore.deleteCustomTabValue(t, KEYS.closedWith);
          }
        }, 0);
      } else {
        const promotion = { from: tab._zttId, to: grandparent?._zttId ?? null };
        for (const child of children) {
          model.setParent(child, grandparent, [...(child._zttPromotions ?? []), promotion]);
        }
      }
    }
    this.trees.scheduleRefresh();
  }

  /** Whether `tab` closes because Zen's window sync is echoing a close made in another window. */
  isSyncEcho(tab) {
    const prefs = Services.prefs;
    if (
      !tab.id ||
      !prefs.getBoolPref("zen.window-sync.enabled", false) ||
      (!tab.pinned && prefs.getBoolPref("zen.window-sync.sync-only-pinned-tabs", false)) ||
      !isSyncedWindow(window)
    ) {
      return false;
    }
    return otherWindows()
      .filter(isSyncedWindow)
      .some(win => {
        const twin = win.document.getElementById(tab.id);
        return !twin || twin.closing;
      });
  }

  #fitsRecentlyClosed(descendants) {
    return descendants.length < Services.prefs.getIntPref("browser.sessionstore.max_tabs_undo", 25);
  }

  onTabRestoring(tab) {
    const model = this.model;
    const restoredId = SessionStore.getCustomTabValue(tab, KEYS.id);
    const original = restoredId && allTabs().find(t => t !== tab && t._zttId === restoredId);
    model.load(tab);
    model.breakCycles();
    if (original) {
      tab._zttId = crypto.randomUUID();
      model.reset(tab, original._zttParentId);
      if (tab.parentNode === original.parentNode) {
        model.moveAfter(tab, model.lastDescendant(original));
      }
    } else {
      this.reclaimPromotedChildren(tab);
      this.restoreClosedTree(tab);
    }
    this.trees.scheduleRefresh();
  }

  /** Tabs moved up when `tab` closed, and not moved since, become its children again. */
  reclaimPromotedChildren(tab) {
    const model = this.model;
    const reclaimed = allTabs().filter(t => {
      const last = t._zttPromotions?.at(-1);
      return (
        last?.from === tab._zttId &&
        (t._zttParentId ?? null) === last.to &&
        t.parentNode === tab.parentNode &&
        model.isEligible(t)
      );
    });
    for (const child of reclaimed) {
      model.setParent(child, tab, child._zttPromotions.slice(0, -1));
    }
    if (reclaimed.length) {
      model.bringDescendants(tab, model.descendantsOf(tab));
    }
  }

  /** When `tab` belongs to a tree closed as a whole, reopens the rest of it in order under its root. */
  restoreClosedTree(tab) {
    const rootId = parseClosedWith(SessionStore.getCustomTabValue(tab, KEYS.closedWith))?.root ?? tab._zttId;
    if (!rootId) {
      return;
    }
    const inTree = extData => extData[KEYS.id] === rootId || parseClosedWith(extData[KEYS.closedWith])?.root === rootId;
    const closed = SessionStore.getClosedTabDataForWindow(window).filter(c => inTree(c.state?.extData ?? {}));
    for (const c of closed) {
      SessionStore.undoCloseById(c.closedId, true, window);
    }
    const root = allTabs().find(t => SessionStore.getCustomTabValue(t, KEYS.id) === rootId);
    const members = allTabs()
      .map(t => ({ t, tag: parseClosedWith(SessionStore.getCustomTabValue(t, KEYS.closedWith)) }))
      .filter(({ tag }) => tag?.root === rootId)
      .sort((a, b) => a.tag.order - b.tag.order)
      .map(({ t }) => t);
    for (const member of members) {
      SessionStore.deleteCustomTabValue(member, KEYS.closedWith);
    }
    if (!root || !members.length) {
      return;
    }
    this.model.bringDescendants(root, members);
    if (closed.length) {
      gBrowser.selectedTab = root;
    }
  }
}
