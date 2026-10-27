import { applyConfig } from "./config.mjs";
import { computeLayout } from "./layout.mjs";
import { TreeModel, allTabs } from "./model.mjs";
import { Renderer } from "./render.mjs";
import { Behaviour } from "./behaviour.mjs";
import { Input } from "./input.mjs";

export class ZenTabTrees {
  model = new TreeModel();
  renderer = new Renderer();
  behaviour = new Behaviour(this);
  input = new Input(this);
  #initialized = false;
  #refreshQueued = false;
  #cleanups = [];

  async init() {
    applyConfig(document.documentElement.style);
    await window.delayedStartupPromise;
    await window.gZenWorkspaces?.promiseInitialized;
    await SessionStore.promiseAllWindowsRestored;
    for (const tab of allTabs()) {
      this.model.load(tab);
    }
    this.model.dropForeignTrees();
    this.model.breakCycles();
    this.#addListeners();
    window.addUnloadListener?.(() => this.teardown());
    this.#initialized = true;
    this.refresh();
  }

  /** Stops reacting to anything and removes what the tree drew. */
  teardown() {
    this.#initialized = false;
    for (const cleanup of this.#cleanups.splice(0)) {
      cleanup();
    }
    this.input.teardown();
    this.behaviour.releaseSuccessor();
    for (const tab of allTabs()) {
      this.renderer.clear(tab);
    }
    for (const el of document.querySelectorAll(".ztt-lines, .ztt-chevron")) {
      el.remove();
    }
    if (window.gZenTabTrees === this) {
      delete window.gZenTabTrees;
    }
  }

  refresh() {
    if (!this.#initialized) {
      return;
    }
    this.model.applyListChanges();
    this.model.repairOrder();
    const nodes = this.model.sidebarNodes();
    const layout = computeLayout(nodes);
    this.model.applyLayout(nodes, layout);
    this.renderer.render(nodes, layout);
    this.model.recordOrder();
    this.behaviour.updateSuccessor();
  }

  scheduleRefresh() {
    if (this.#refreshQueued || !this.#initialized) {
      return;
    }
    this.#refreshQueued = true;
    requestAnimationFrame(() => {
      this.#refreshQueued = false;
      this.refresh();
    });
  }

  /** Collapses or expands `owner`: a parent tab (and every level below if `recursive`) or a Zen folder. */
  toggle(owner, recursive = false) {
    if (gBrowser.isTab(owner)) {
      this.model.toggleCollapsed(owner, recursive);
      this.refresh();
    } else {
      owner.collapsed = !owner.collapsed;
    }
  }

  #listen(target, type, capture = false) {
    target.addEventListener(type, this, capture);
    this.#cleanups.push(() => target.removeEventListener(type, this, capture));
  }

  #observe(callback, target, options) {
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    this.#cleanups.push(() => observer.disconnect());
  }

  #addListeners() {
    const container = gBrowser.tabContainer;
    for (const type of [
      "TabOpen", "TabClose", "TabMove", "TabSelect", "TabPinned", "TabUnpinned", "SSTabRestoring",
      "TabGrouped", "TabUngrouped", "TabGroupCollapse", "TabGroupExpand",
    ]) {
      this.#listen(container, type);
    }
    for (const type of ["mousedown", "mouseup", "click", "auxclick", "dblclick", "dragstart"]) {
      this.#listen(container, type, true);
    }
    for (const type of ["dragover", "drop", "dragend", "mouseup"]) {
      this.#listen(window, type, true);
    }
    this.#listen(container, "mouseover");
    this.#listen(container, "mouseleave");
    for (const type of ["ZenWorkspacesUIUpdate", "ZenWorkspaceDataChanged", "ZenFolderChangedWorkspace"]) {
      this.#listen(window, type);
    }
    const loaded = Ci.nsIWebProgressListener.STATE_STOP | Ci.nsIWebProgressListener.STATE_IS_NETWORK;
    const progress = {
      onStateChange: (browser, webProgress, request, stateFlags) => {
        if (webProgress.isTopLevel && (stateFlags & loaded) === loaded) {
          this.behaviour.onPageLoaded(gBrowser.getTabForBrowser(browser), browser.currentURI.spec);
        }
      },
    };
    gBrowser.addTabsProgressListener(progress);
    this.#cleanups.push(() => gBrowser.removeTabsProgressListener(progress));
    this.#observe(
      records => {
        for (const { target, oldValue } of records) {
          if (oldValue !== null && !target.hasAttribute("zen-glance-tab")) {
            this.behaviour.onGlanceOpened(target);
          }
        }
      },
      container,
      { subtree: true, attributes: true, attributeFilter: ["zen-glance-tab"], attributeOldValue: true }
    );
    this.#observe(() => this.scheduleRefresh(), gNavToolbox, {
      attributes: true,
      attributeFilter: ["zen-sidebar-expanded"],
    });
  }

  handleEvent(event) {
    if (event.type === "mouseup" && event.currentTarget === window) {
      this.input.onMouseUp();
      return;
    }
    switch (event.type) {
      case "mousedown":
      case "mouseup":
      case "click":
      case "auxclick":
      case "dblclick":
        this.input.onPointer(event);
        break;
      case "dragstart":
        if (!this.input.onPointer(event)) {
          this.input.onDragStart(event);
        }
        break;
      case "dragover":
        this.input.onDragOver(event);
        break;
      case "drop":
        this.input.onDrop(event);
        break;
      case "dragend":
        this.input.onDragEnd();
        break;
      case "TabMove":
        this.behaviour.onTabMove(event.target);
        break;
      case "mouseover":
      case "mouseleave":
        this.input.onHover(event);
        break;
      case "TabOpen":
        this.behaviour.onTabOpen(event.target);
        break;
      case "TabClose":
        this.behaviour.onTabClose(event.target, event.detail);
        break;
      case "SSTabRestoring":
        this.behaviour.onTabRestoring(event.target);
        break;
      default:
        this.scheduleRefresh();
    }
  }
}

if (globalThis.location?.href === "chrome://browser/content/browser.xhtml" && !window.gZenTabTrees) {
  window.gZenTabTrees = new ZenTabTrees();
  window.gZenTabTrees.init().catch(e => console.error("[Zen Tab Trees] init failed", e));
}
