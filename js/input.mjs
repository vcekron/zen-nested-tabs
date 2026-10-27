import { TREE } from "./config.mjs";
import { ancestors, dropTarget } from "./layout.mjs";
import { html, isRtl, isSidebarExpanded } from "./render.mjs";
import { isFixedItem } from "./model.mjs";

// Grabbing a tab by its title text makes the label's text node the event target.
const targetElement = event =>
  event.target?.nodeType === Node.TEXT_NODE ? event.target.parentElement : event.target;

const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";

/** Pointer input on the tree: chevron and connector clicks, connector hover, drag and drop within a list. */
export class Input {
  #drag = null;
  #overlay = null;

  constructor(trees) {
    this.trees = trees;
  }

  get model() {
    return this.trees.model;
  }

  #ownerOf(key) {
    return key.startsWith("f:") ? document.getElementById(key.slice(2)) : this.model.idMap().get(key);
  }

  /** Capture-phase mousedown/mouseup/click/auxclick/dblclick/dragstart: the tree's controls win over the tab's. */
  /** Capture-phase mouseup anywhere in the window: a drag that never started gets no dragend. */
  onMouseUp() {
    if (this.#drag) {
      this.#endDrag();
    }
  }

  onPointer(event) {
    const target = targetElement(event);
    const hit = target?.closest?.(".ztt-hit");
    const chevron = hit ? null : target?.closest?.(".ztt-chevron");
    if (!hit && !chevron) {
      return false;
    }
    event.stopPropagation();
    event.preventDefault();
    if (event.type === "click" && event.button === 0) {
      const owner = hit ? this.#ownerOf(hit._zttOwner) : chevron.closest(".tabbrowser-tab");
      if (hit) {
        this.trees.renderer.setHoverOwner(null);
      }
      if (owner?.isConnected) {
        this.trees.toggle(owner, event.ctrlKey || event.metaKey);
      }
    }
    return true;
  }

  onHover(event) {
    const hit = event.type === "mouseover" ? targetElement(event)?.closest?.(".ztt-hit") : null;
    this.trees.renderer.setHoverOwner(hit?._zttOwner ?? null);
  }

  onDragStart(event) {
    this.#endDrag();
    const tab = targetElement(event)?.closest?.(".tabbrowser-tab");
    if (
      !this.model.isEligible(tab) ||
      !isSidebarExpanded() ||
      (tab.multiselected && gBrowser.selectedTabs.length > 1)
    ) {
      return;
    }
    const box = tab.parentNode.closest?.("arrowscrollbox") || gBrowser.tabContainer.arrowScrollbox;
    const rect = tab.getBoundingClientRect();
    const rtl = isRtl();
    this.#drag = {
      tab,
      list: tab.parentNode,
      subtree: new Set(this.model.descendantsOf(tab)),
      rtl,
      grabOffset: rtl ? rect.right - event.clientX : event.clientX - rect.left,
      rowElements: new Map(),
      startY: event.clientY,
      box,
      startScroll: box?.scrollbox?.scrollTop ?? 0,
      x: event.clientX,
      y: event.clientY,
      dy: null,
      target: null,
      dropParent: null,
      expandTimer: 0,
      expandKey: null,
    };
    for (const t of [tab, ...this.#drag.subtree]) {
      t.setAttribute("ztt-drag-source", "");
    }
  }

  onDragOver(event) {
    const drag = this.#drag;
    if (!drag) {
      return;
    }
    if (!this.#owns(event)) {
      this.#endDrag();
      return;
    }
    const list = this.#listUnder(event);
    document.documentElement.toggleAttribute("ztt-dragging", !!list);
    if (!list) {
      drag.target = null;
      this.#hideIndicator();
      this.#cancelAutoExpand();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    this.#track(drag, event);
    this.#autoScroll(drag);
    this.#setOffset(drag);
    drag.target = this.#target(drag, list);
    const drop = drag.target ? this.resolveDrop(drag, drag.target) : null;
    this.#showIndicator(drag, drop);
    this.#scheduleAutoExpand(drag, drop);
  }

  onDrop(event) {
    const drag = this.#drag;
    if (!drag) {
      return;
    }
    if (!this.#owns(event)) {
      this.#endDrag();
      return;
    }
    const list = this.#listUnder(event);
    if (!list) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.#track(drag, event);
    const target = this.#target(drag, list);
    this.#endDrag();
    if (target) {
      this.applyDrop(drag, target);
    }
  }

  /** Moves the dragged tab, with its subtree, to a dropTarget() result, into that target's list if needed. */
  applyDrop(drag, target) {
    const model = this.model;
    const map = model.idMap();
    const ref = map.get(target.prev) ?? map.get(target.next);
    const fixed = drag.rowElements?.get(target.prev) ?? drag.rowElements?.get(target.next);
    const { parent, after } = this.resolveDrop(drag, target);
    if (
      (ref && ref.parentNode !== drag.tab.parentNode && !model.moveIntoList(drag.tab, ref)) ||
      (!ref && fixed && fixed.parentNode !== drag.tab.parentNode)
    ) {
      this.trees.refresh();
      return;
    }
    model.moveSubtree(drag.tab, parent, after);
    model.carrySubtree(drag.tab, [...drag.subtree]);
    this.trees.refresh();
  }

  onDragEnd() {
    this.#endDrag();
  }

  /** Ends any drag and removes the drop indicator. */
  teardown() {
    this.#endDrag();
    this.#overlay?.line.remove();
    this.#overlay?.label.remove();
    this.#overlay = null;
  }

  /**
   * The moveSubtree() arguments for a dropTarget() result: { parent, after }
   * (`after` a tab, folder or split view; either may be null). Depths are the
   * ones drawn on screen.
   */
  resolveDrop(drag, target) {
    const model = this.model;
    const fixed = target.prev ? drag.rowElements?.get(target.prev) : null;
    if (fixed) {
      return { parent: null, after: fixed };
    }
    const map = model.idMap();
    const prev = target.prev ? map.get(target.prev) : null;
    if (!prev) {
      return { parent: null, after: null };
    }
    const drawn = this.trees.renderer?.entryOf(prev._zttId);
    const above = drawn ? drawn.chain.map(key => map.get(key)) : ancestors(prev, t => model.liveParent(t, map));
    const chain = [prev, ...above];
    const prevDepth = chain.length - 1;
    const parent = target.depth > 0 ? (chain[prevDepth - (target.depth - 1)] ?? null) : null;
    const moving = new Set([drag.tab, ...drag.subtree]);
    const after = target.depth === prevDepth + 1 ? prev : model.lastDescendant(prev, moving);
    return { parent, after };
  }

  /** Whether `event` carries the tab this drag started with, still open. */
  #owns(event) {
    const tab = this.#drag.tab;
    return tab.isConnected && event.dataTransfer?.mozGetDataAt?.(TAB_DROP_TYPE, 0) === tab;
  }

  #setOffset(drag) {
    const scrolled = (drag.box?.scrollbox?.scrollTop ?? 0) - drag.startScroll;
    const dy = `${drag.y - drag.startY + scrolled}px`;
    if (dy !== drag.dy) {
      drag.dy = dy;
      for (const t of [drag.tab, ...drag.subtree]) {
        t.style.setProperty("--ztt-drag-dy", dy);
      }
    }
  }

  #setDropParent(drag, parent) {
    if (drag.dropParent !== parent) {
      drag.dropParent?.removeAttribute("ztt-drop-parent");
      parent?.setAttribute("ztt-drop-parent", "");
      drag.dropParent = parent;
    }
  }

  #track(drag, event) {
    if (event.clientX || event.clientY) {
      drag.x = event.clientX;
      drag.y = event.clientY;
    }
  }

  /** The list the pointer is over, if the tree handles a drop there: rows of any list in the dragged tab's space, or empty space in its own list. */
  #listUnder(event) {
    const drag = this.#drag;
    const node = targetElement(event);
    if (!drag || !node?.closest) {
      return null;
    }
    const row = node.closest(".tabbrowser-tab");
    if (row) {
      const sameSpace = row.getAttribute("zen-workspace-id") === drag.tab.getAttribute("zen-workspace-id");
      return this.model.isEligible(row) && sameSpace ? row.parentNode : null;
    }
    if (node !== drag.list && !drag.list.contains(node)) {
      return null;
    }
    const folder = node.closest("zen-folder");
    return !folder || !drag.list.contains(folder) ? drag.list : null;
  }

  /** The drop for the pointer's position in `list`, from its rows as drawn: tabs, folders and split views. */
  #target(drag, list) {
    const model = this.model;
    const map = model.idMap();
    const rows = [];
    drag.rowElements = new Map();
    [...list.children].forEach((el, index) => {
      const fixed = isFixedItem(el);
      const tab =
        !fixed &&
        gBrowser.isTab(el) &&
        model.isPlaced(el) &&
        el !== drag.tab &&
        !drag.subtree.has(el) &&
        !el.hasAttribute("ztt-hidden");
      if (!fixed && !tab) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (!rect.height) {
        return;
      }
      const key = fixed ? `fixed:${index}` : el._zttId;
      if (fixed) {
        drag.rowElements.set(key, el);
      }
      const depth = fixed ? 0 : (this.trees.renderer?.entryOf(key)?.depth ?? model.depthOf(el, map));
      rows.push({ key, depth, fixed, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
    });
    return dropTarget(rows, { x: drag.x, y: drag.y, grabOffset: drag.grabOffset }, drag.target, drag.rtl);
  }

  #endDrag() {
    const drag = this.#drag;
    this.#hideIndicator();
    this.#drag = null;
    document.documentElement.removeAttribute("ztt-dragging");
    if (drag) {
      clearTimeout(drag.expandTimer);
      for (const t of [drag.tab, ...drag.subtree]) {
        t.removeAttribute("ztt-drag-source");
        t.style.removeProperty("--ztt-drag-dy");
      }
    }
  }

  #showIndicator(drag, drop) {
    const target = drag.target;
    if (!target) {
      this.#hideIndicator();
      return;
    }
    const { parent } = drop;
    this.#setDropParent(drag, parent);
    const { line, label } = this.#ensureOverlay();
    line.style.left = `${target.left}px`;
    line.style.width = `${Math.max(0, target.right - target.left)}px`;
    line.style.top = `calc(${target.y}px - var(--ztt-line-width) / 2)`;
    line.hidden = false;
    if (parent) {
      const title = html("span");
      title.className = "ztt-drop-title";
      title.textContent = parent.label ?? "";
      label.replaceChildren("↳ Inside “", title, "”");
    } else {
      label.replaceChildren("Top level");
    }
    label.toggleAttribute("ztt-root", !parent);
    label.style.top = `${target.y}px`;
    label.style.left = `${drag.rtl ? target.left : target.right}px`;
    label.hidden = false;
  }

  #hideIndicator() {
    if (this.#drag) {
      this.#setDropParent(this.#drag, null);
    }
    if (this.#overlay) {
      this.#overlay.line.hidden = true;
      this.#overlay.label.hidden = true;
    }
  }

  #ensureOverlay() {
    if (!this.#overlay) {
      const line = html("div");
      line.id = "ztt-drop-line";
      const label = html("div");
      label.id = "ztt-drop-label";
      line.hidden = label.hidden = true;
      (document.body || document.documentElement).append(line, label);
      this.#overlay = { line, label };
    }
    return this.#overlay;
  }

  #scheduleAutoExpand(drag, drop) {
    const prev = drop?.parent?._zttId === drag.target?.prev ? drop.parent : null;
    const wantsInside = !!prev?._zttCollapsed;
    const key = wantsInside ? prev._zttId : null;
    if (key === drag.expandKey) {
      return;
    }
    this.#cancelAutoExpand();
    drag.expandKey = key;
    if (wantsInside) {
      drag.expandTimer = setTimeout(() => {
        if (this.#drag === drag && prev.isConnected) {
          this.model.setCollapsed(prev, false);
          this.trees.refresh();
        }
      }, TREE.dragExpandDelay);
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

  #autoScroll(drag) {
    const box = drag.box;
    if (!box?.scrollByPixels) {
      return;
    }
    const rect = box.getBoundingClientRect();
    const zone = TREE.dragScrollZone;
    let dy = 0;
    if (drag.y < rect.top + zone) {
      dy = -Math.ceil((rect.top + zone - drag.y) / TREE.dragScrollDivisor);
    } else if (drag.y > rect.bottom - zone) {
      dy = Math.ceil((drag.y - (rect.bottom - zone)) / TREE.dragScrollDivisor);
    }
    if (dy) {
      box.scrollByPixels(dy, true);
    }
  }
}
