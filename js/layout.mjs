import { TREE } from "./config.mjs";

/** Yields `start`'s parent, its parent and so on, stopping at the root or where the chain loops back. */
export function* ancestors(start, parentOf) {
  const seen = new Set([start]);
  for (let p = parentOf(start); p && !seen.has(p); p = parentOf(p)) {
    seen.add(p);
    yield p;
  }
}

/**
 * Per-row tree layout for the sidebar.
 *
 * `nodes` are the sidebar rows in order: { key, kind: "tab"|"folder"|"split",
 * parent (display parent key or null), collapsed, selected, revealed,
 * inCollapsedFolder, folderActive (shown by Zen inside a collapsed folder) }.
 * Returns key → { depth, chain, hidden, revealed, flatten, collapsed,
 * descendants, columns }, where `chain` lists the keys of the tab ancestors
 * drawn above the row (nearest first), `columns` lists the row's drawn
 * connector columns as { column, owner, ownerKind, own, continues } and
 * `flatten` counts the folders Zen flattens between the row and its
 * collapsed folder.
 */
export function computeLayout(nodes) {
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const ancestorsOf = node => [...ancestors(node, n => byKey.get(n.parent))];

  const layout = new Map();
  const rows = [];
  for (const node of nodes) {
    const ancestors = ancestorsOf(node);
    let entry;
    let shown = ancestors;
    if (node.inCollapsedFolder) {
      const collapsedFolder = ancestors.findLastIndex(a => a.kind === "folder" && a.collapsed);
      const active = node.folderActive && collapsedFolder >= 0;
      shown = active ? ancestors.slice(collapsedFolder) : [];
      entry = {
        depth: 0,
        chain: [],
        hidden: false,
        revealed: false,
        flatten: active ? ancestors.slice(0, collapsedFolder).filter(a => a.kind === "folder").length : 0,
      };
    } else {
      const outermostCollapsed = ancestors.findLastIndex(a => a.kind === "tab" && a.collapsed);
      const revealed = outermostCollapsed >= 0 && (node.revealed || node.selected);
      shown = revealed ? ancestors.slice(outermostCollapsed) : ancestors;
      const chain = shown.filter(a => a.kind === "tab").map(a => a.key);
      entry = {
        depth: chain.length,
        chain,
        hidden: outermostCollapsed >= 0 && !revealed,
        revealed,
        flatten: 0,
      };
    }
    Object.assign(entry, { collapsed: false, descendants: 0, columns: [] });
    layout.set(node.key, entry);
    rows.push({ node, ancestors, shown, entry });
  }

  const lastChild = new Map();
  for (const { node, ancestors, shown, entry } of rows) {
    if (node.kind === "tab") {
      for (const a of ancestors) {
        if (a.kind === "tab") {
          layout.get(a.key).descendants++;
        }
      }
    }
    if (!entry.hidden && shown.length) {
      lastChild.set(shown[0].key, node.key);
    }
  }

  for (const { node, shown, entry } of rows) {
    entry.collapsed = node.kind === "tab" && node.collapsed && entry.descendants > 0;
    if (entry.hidden) {
      continue;
    }
    const chain = [...shown].reverse();
    chain.push(node);
    for (let column = 0; column < shown.length; column++) {
      const owner = chain[column];
      const own = column === shown.length - 1;
      const continues = lastChild.get(owner.key) !== chain[column + 1].key;
      if (own || continues) {
        entry.columns.push({ column, owner: owner.key, ownerKind: owner.kind, own, continues });
      }
    }
  }
  return layout;
}

/**
 * The parent a row placed between `prev` and `next` (keys or null) joins:
 * `next`'s parent when `next` hangs under `prev` or one of its ancestors,
 * else null. `parentOf` maps a key to its parent key or null.
 */
export function positionalParent(prev, next, parentOf) {
  const nextParent = next ? parentOf(next) : null;
  if (!prev || !nextParent) {
    return null;
  }
  return prev === nextParent || [...ancestors(prev, parentOf)].includes(nextParent) ? nextParent : null;
}

/**
 * The first move that keeps a list's subtrees contiguous, or null when none
 * is needed. `items` are one list's rows in order: { key, parent (live parent
 * key or null), orphan (has a parent that is not live) }. Returns { key,
 * anchor }: move `key` with its subtree to directly after `anchor`.
 */
export function nextRepairMove(items) {
  const byKey = new Map(items.map(item => [item.key, item]));
  const parentOf = key => byKey.get(key)?.parent ?? null;
  const isAncestor = (ancestor, key) => [...ancestors(key, parentOf)].includes(ancestor);
  const isFloating = key => !!key && !!byKey.get([key, ...ancestors(key, parentOf)].at(-1)).orphan;
  const inBlock = (parent, key) => !!key && (key === parent || isAncestor(parent, key));

  let lastAny = null;
  let lastFixed = null;
  for (const { key, parent } of items) {
    if (parent && !(inBlock(parent, lastAny) || (isFloating(lastAny) && inBlock(parent, lastFixed)))) {
      const parentFloats = isFloating(parent);
      let anchor = parent;
      for (const other of items.slice(items.findIndex(item => item.key === parent) + 1)) {
        if (other.key === key || isAncestor(key, other.key)) {
          continue;
        }
        if (inBlock(parent, other.key)) {
          anchor = other.key;
        } else if (parentFloats || !isFloating(other.key)) {
          break;
        }
      }
      return { key, anchor };
    }
    lastAny = key;
    if (!isFloating(key)) {
      lastFixed = key;
    }
  }
  return null;
}

/**
 * Where a dragged row would drop. `rows` are the visible rows of its list
 * without the dragged subtree: { key, depth, fixed, top, bottom, left, right }
 * in screen px, `fixed` marking folders and split views (nothing nests under
 * them). `pointer` is { x, y, grabOffset } (grabOffset: pointer distance from
 * the dragged row's start edge). `previous` is the last result or null.
 * Returns { prev, next, depth, key, y, left, right } or null; `left` and
 * `right` are the drop line's physical edges.
 */
export function dropTarget(rows, pointer, previous, rtl = false) {
  if (!rows.length) {
    return null;
  }
  let index = rows.findIndex(row => pointer.y < (row.top + row.bottom) / 2);
  if (index === -1) {
    index = rows.length;
  }
  const prev = rows[index - 1] ?? null;
  const next = rows[index] ?? null;
  const max = prev && !prev.fixed ? prev.depth + 1 : 0;
  const min = Math.min(max, next ? next.depth : 0);

  const ref = prev ?? next;
  const rootStart = rtl ? ref.right + ref.depth * TREE.indent : ref.left - ref.depth * TREE.indent;
  const rowStart = rtl ? pointer.x + pointer.grabOffset : pointer.x - pointer.grabOffset;
  const level = (rtl ? rootStart - rowStart : rowStart - rootStart) / TREE.indent;
  const key = `${prev?.key}|${next?.key}`;
  let depth = Math.round(level);
  if (previous?.key === key && Math.abs(level - previous.depth) < TREE.dragLevelHysteresis) {
    depth = previous.depth;
  }
  depth = Math.max(min, Math.min(max, depth));

  let y;
  if (prev && next) {
    y = (prev.bottom + next.top) / 2;
  } else if (prev) {
    y = prev.bottom + TREE.dropEdgeOffset;
  } else {
    y = next.top - TREE.dropEdgeOffset;
  }
  return {
    prev: prev?.key ?? null,
    next: next?.key ?? null,
    depth,
    key,
    y,
    left: rtl ? ref.left : rootStart + depth * TREE.indent,
    right: rtl ? rootStart - depth * TREE.indent : ref.right,
  };
}
