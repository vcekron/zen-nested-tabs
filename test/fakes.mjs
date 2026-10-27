export function installFakes() {
  const items = [];
  const isTab = new WeakSet();
  const values = new Map();
  const store = { writes: [], closed: [] };
  const violations = [];
  const prefs = new Map();
  const windows = [];

  const element = (extra = {}) =>
    Object.defineProperties(
      {
        attrs: {},
        parentNode: null,
        get parentElement() { return this.parentNode ?? null; },
        hasAttribute(a) { return a in this.attrs; },
        getAttribute(a) { return this.attrs[a] ?? null; },
        setAttribute(a, v) { this.attrs[a] = String(v); },
        removeAttribute(a) { delete this.attrs[a]; },
      },
      Object.getOwnPropertyDescriptors(extra)
    );

  const list = name => element({ name, get children() { return items.filter(i => i.parentNode === this); } });

  const isWithin = (item, owner) => {
    for (let el = item.parentNode; el; el = el.parentElement) {
      if (el === owner) {
        return true;
      }
    }
    return false;
  };
  const endOf = target => {
    let index = items.indexOf(target);
    items.forEach((item, i) => {
      if (isWithin(item, target)) {
        index = Math.max(index, i);
      }
    });
    return index;
  };
  const remove = item => {
    const index = items.indexOf(item);
    if (index >= 0) {
      items.splice(index, 1);
    }
  };
  const appendTo = (item, listNode) => {
    changed();
    remove(item);
    const inside = items.filter(x => x !== listNode && isWithin(x, listNode));
    const owner = listNode.parentNode;
    let index = items.length;
    if (inside.length) {
      index = endOf(inside.at(-1)) + 1;
    } else if (owner && items.includes(owner)) {
      index = items.indexOf(owner) + 1;
    }
    items.splice(index, 0, item);
    item.parentNode = listNode;
  };
  const ownerGroup = listNode => (listNode?.parentNode?.isZenFolder ? listNode.parentNode : listNode?.isSplit ? listNode : null);

  const tab = (label, listNode, { pinned = false, attrs = {}, group, stored = {} } = {}) => {
    const t = element({ label, pinned, closing: false, isConnected: true, selected: false });
    t.group = group === undefined ? ownerGroup(listNode) : group;
    t.linkedBrowser = { currentURI: { spec: "about:blank" } };
    Object.assign(t.attrs, attrs);
    isTab.add(t);
    if (ownerGroup(listNode)) {
      appendTo(t, listNode);
    } else {
      items.push(t);
      t.parentNode = listNode;
    }
    changed();
    values.set(t, new Map(Object.entries(stored)));
    return t;
  };

  const place = (t, target, after, external = false) => {
    if (!external && t.parentNode !== target.parentNode) {
      violations.push([t, target]);
    }
    changed();
    remove(t);
    items.splice(after ? endOf(target) + 1 : items.indexOf(target), 0, t);
    t.parentNode = target.parentNode;
  };

  const state = { active: "w" };
  const rootOf = node => {
    let n = node;
    while (n?.parentElement) {
      n = n.parentElement;
    }
    return n;
  };
  const rank = t => (rootOf(t.parentNode)?.normal ? 1 : 0);
  let cache = null;
  const ordered = () =>
    (cache ??= items
      .filter(t => isTab.has(t) && t.isConnected)
      .sort((a, b) => rank(a) - rank(b) || items.indexOf(a) - items.indexOf(b)));
  const changed = () => (cache = null);
  const inActiveSpace = t => (t.getAttribute("zen-workspace-id") ?? state.active) === state.active || t.hasAttribute("zen-essential");

  globalThis.window = globalThis;
  windows.push(globalThis);
  globalThis.gBrowser = {
    get tabs() { changed(); return ordered().filter(inActiveSpace); },
    isTab: el => isTab.has(el),
    moveTabAfter: (t, target) => place(t, target, true),
    moveTabBefore: (t, target) => place(t, target, false),
    removeTabs(list) {
      for (const t of list) {
        if (store.keepOpen?.has(t)) {
          continue;
        }
        t.closing = true;
        t.isConnected = false;
      }
      changed();
      store.removed = [...(store.removed ?? []), ...list];
    },
  };

  globalThis.SessionStore = {
    getCustomTabValue: (t, k) => values.get(t)?.get(k) ?? "",
    setCustomTabValue(t, k, v) {
      if (typeof v !== "string") {
        throw new TypeError("setCustomTabValue only accepts string values");
      }
      store.writes.push([t, k, v]);
      values.get(t).set(k, v);
    },
    deleteCustomTabValue(t, k) {
      store.writes.push([t, k, null]);
      values.get(t).delete(k);
    },
    getClosedTabDataForWindow: () => store.closed,
    undoCloseById(id) {
      const closed = store.closed.find(c => c.closedId === id);
      if (!closed) {
        return undefined;
      }
      store.closed = store.closed.filter(c => c !== closed);
      return tab(closed.label, closed.list, { stored: closed.state.extData });
    },
  };

  globalThis.Services = {
    prefs: {
      getIntPref: (name, fallback) => (prefs.has(name) ? prefs.get(name) : fallback),
      getBoolPref: (name, fallback) => (prefs.has(name) ? prefs.get(name) : fallback),
    },
    wm: { getEnumerator: () => windows.values() },
  };

  const spaces = new Map();
  const space = id => {
    if (!spaces.has(id)) {
      const normal = list(`${id}:normal`);
      normal.normal = true;
      spaces.set(id, { normal, pinned: list(`${id}:pinned`) });
    }
    return spaces.get(id);
  };
  const spaceOf = t => space(t.getAttribute("zen-workspace-id") ?? "w");
  const group = (extra, listNode) => {
    const g = element(extra);
    if (listNode) {
      items.push(g);
      g.parentNode = listNode;
      changed();
    }
    return g;
  };
  const folder = (name, listNode = null) => {
    const container = list(`${name}:container`);
    const F = group(
      {
        isZenFolder: true,
        id: name,
        container,
        collapsed: false,
        addTabs(tabs) {
          for (const t of tabs) {
            t.group = this;
            appendTo(t, container);
          }
        },
      },
      listNode
    );
    container.parentNode = F;
    return F;
  };
  const split = (name, listNode = null) => {
    const S = group(
      {
        id: name,
        isSplit: true,
        get tabs() { return items.filter(i => isTab.has(i) && i.parentNode === this); },
        get children() { return this.tabs; },
      },
      listNode
    );
    S.attrs["split-view-group"] = "true";
    return S;
  };

  Object.assign(globalThis.gBrowser, {
    pinTab(t) {
      t.pinned = true;
      appendTo(t, space(state.active).pinned);
    },
    unpinTab(t) {
      t.pinned = false;
      t.group = null;
      appendTo(t, spaceOf(t).normal);
    },
    ungroupTab(t) {
      t.group = null;
      appendTo(t, t.pinned ? spaceOf(t).pinned : spaceOf(t).normal);
    },
  });
  globalThis.gZenWindowSync = {
    setPinnedTabState(t) {
      store.pinnedStates = [...(store.pinnedStates ?? []), t];
      return Promise.resolve();
    },
  };
  globalThis.gZenPinnedTabManager = {
    resetPinChangedUrl(t) {
      store.resets = [...(store.resets ?? []), t];
    },
  };
  globalThis.gZenWorkspaces = {
    get allStoredTabs() { return ordered(); },
    moveTabToWorkspace(t, id) {
      t.setAttribute("zen-workspace-id", id);
      appendTo(t, t.pinned ? space(id).pinned : space(id).normal);
    },
  };

  const order = (listNode = null) =>
    ordered().filter(t => !listNode || t.parentNode === listNode).map(t => t.label).join(" ");
  const externalMove = (t, target, after) => place(t, target, after, true);

  return {
    tabs: items, values, store, state, element, list, tab, order, space, folder, split,
    violations, prefs, windows, externalMove,
  };
}
