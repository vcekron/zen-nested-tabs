# Zen Nested Tabs

Tree Style Tab–style nesting for Zen's vertical tabs. Zen's tabs keep their usual look and gain parent/child trees you can collapse.

This is a fork of [nigeltroy-gpt0/zen-nested-tabs](https://github.com/nigeltroy-gpt0/zen-nested-tabs) with fixes for undo (Ctrl/Cmd+Shift+T), closing collapsed trees and dragging tabs by their title.

## What it does

- **Automatic nesting.** A tab opened from a link (middle-click, `target=_blank`, `window.open`) becomes a child of the tab that opened it and goes to the end of that tab's children. New tabs from Ctrl/Cmd+T, bookmarks and the URL bar stay at the top level. You can turn this off in the mod's preferences.
- **26px per level by default.** Each level is indented 26px, the same step as folder contents with Zen Folder Tree Connectors installed; change it with the *Indent per nesting level* setting (4–64px). Changes apply immediately. Inside a Zen folder, the indent is added on top of the folder's own indent.
- **Tree lines.** By default, rounded connectors (├, ╰) run from under the parent's icon to each child's vertical center, with a vertical line only where a tree continues below. With an indent below about 25px, the line moves left of the icon to leave room for the branch. The *Tree lines* setting can switch to faint indent guides or turn the lines off. The connector look is inspired by [Zen Folder Tree Connectors](https://github.com/JustAdumbPrsn/ZenFolderTreeConnectors).
- **Carets.** Every tab that has children shows a caret at the far right edge of the tab. The close button appears to its left on hover, so it never slides into the caret's spot. The *Expand/collapse caret position* setting can instead put the caret just before the close button, or on the left before the favicon. Click it to collapse or expand that tree. Ctrl/Cmd-click collapses or expands every level below it. A collapsed parent shows how many tabs it is hiding (you can turn this off).
- **The sidebar grows with nesting.** The minimum sidebar width is Zen's own minimum plus one indent (26px by default) for each visible level. If a new level doesn't fit, the sidebar widens to the new minimum. When nesting gets shallower, the minimum drops, so you can drag the sidebar narrower again, but the mod never shrinks it for you. Zen's drag-to-resize respects the same minimum.
- **Essentials are never nested.** Essentials, Glance previews and Zen's empty placeholder tab are left out completely.
- **Drag and drop.** While you drag a tab within its list, the mod handles the drop itself as one tree move, and the tab's children always come with it.
  - **Up and down** picks the gap between two rows.
  - **Left and right** picks the level, from where the dragged tab's left edge is. Move right to nest, left to un-nest. The level snaps to the nearest one that's valid in that gap. Directly below a parent whose children are showing, the tab can only go in as its first child.
  - **A line with a dot** sits in the gap and starts at the indent the tab will get. A label at the end of the line says *↳ Inside "…"* or *Top level*, and the future parent is highlighted. Dropping does exactly what the indicator shows.
  - **Hovering as a child of a collapsed tab** for a moment expands it. Dragging near the top or bottom edge of the list scrolls it.
  - **Drags elsewhere are Zen's:** into Essentials, the pinned tabs, a folder, another space or another window. Zen handles those, and the tab leaves its tree while its children move up to its parent. Dragging several selected tabs at once also uses Zen's normal reordering.
- **Other moves.** Keyboard shortcuts and extensions that move a tab follow Tree Style Tab's rule: the tab joins the level of the tab below it, and its children move with it.
- **Closing a parent.** Choose one of: *Close the whole tree*, *Close the whole tree, only if collapsed*, or *Move children up one level* (the default).
- **Undo restores the tree.** Reopening a closed parent with Ctrl/Cmd+Shift+T puts back the children that were moved up a level when it closed, unless you have moved them since. A tree that was closed as a whole comes back with one Ctrl/Cmd+Shift+T, collapsed state included. Both also work after a restart.
- **Tab context menu.** *Nest Under Tab Above*, *Move Out One Level*, *Collapse/Expand Tree*, *Collapse All Trees*, *Expand All Trees*.
- **The tree is saved with your session**, using SessionStore's custom tab values, so it survives restarts.

Trees stay inside one list: a space's normal tabs, its pinned tabs, or a single folder. If a tab moves to another list (pinning it, putting it in a folder, moving it to another space), it leaves its tree.

Each tree also stays together in the sidebar. If a tab ends up outside its parent's group, for example when closed tabs are reopened one at a time with Ctrl/Cmd+Shift+T, the mod moves it (with its children) back to the end of its parent's group. A tab whose parent is still closed is left where it is until the parent comes back.

## Why this needs JavaScript

Zen Mods from the official store are CSS only. CSS can indent and hide tabs, but it can't track which tab opened which, save the tree, handle a caret click, or resize the sidebar. So this mod comes in two parts:

| File | Role |
| --- | --- |
| `chrome.css` | All the visuals: indent, caret, counter, guide lines, hiding collapsed tabs |
| `js/nested-tabs.uc.js` | The tree model, event handling, session saving, sidebar width |
| `preferences.json` | Preferences, in the Zen Mods / Sine format |
| `theme.json` | Mod manifest, in the Sine format (declares the script) |

## Install

### Option A: Sine (recommended)

[Sine](https://github.com/CosmoCreeper/Sine) is a community mod manager that supports the Zen mod format and also loads `.uc.js` scripts.

1. Install Sine (see its README).
2. The mod is hosted at `vcekron/zen-nested-tabs`.
3. Open **Settings → Sine Mods** and add the mod by entering `vcekron/zen-nested-tabs`.
4. Sine only runs JavaScript from mods outside its store if you allow it. Turn on Sine's option to allow unsafe JS for non-store mods, then restart Zen.

> [!WARNING]
> **What you are trusting.** The script runs with full browser privileges: it can do anything Zen itself can, including reading your files, cookies and saved passwords. Sine's unsafe JS option is global, so it lets *every* non-store mod you install run JavaScript, not just this one. Sine also auto-updates mods from the `main` branch of their repository. To review each update before it runs, turn off auto-updating for this mod in Sine's mod list and read the [commit history](https://github.com/vcekron/zen-nested-tabs/commits/main) before updating by hand.

### Option B: fx-autoconfig by hand

1. Install [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) for Zen. [zen-autoconfig-script](https://github.com/RayZ3R0/zen-autoconfig-script) can do this for you.
2. Copy `js/nested-tabs.uc.js` to `<profile>/chrome/JS/`.
3. Add `@import "nested-tabs.css";` to the top of `<profile>/chrome/userChrome.css`, and copy `chrome.css` to `<profile>/chrome/nested-tabs.css`.
4. To change the defaults, set the `mod.nestedtabs.*` preferences in `about:config`. The script registers the defaults itself.
5. Open `about:support`, click **Clear startup cache…**, and restart.

## Preferences

| Pref | Default | |
| --- | --- | --- |
| `mod.nestedtabs.auto_nest` | `true` | Nest tabs opened from links |
| `mod.nestedtabs.indent` | `26` | Indent per nesting level in px (4–64); also sets how much the sidebar's minimum width grows per level |
| `mod.nestedtabs.tree_lines` | `connectors` | `connectors` (rounded tree connectors), `guides` (faint vertical guide lines for each level) or `off` |
| `mod.nestedtabs.show_count` | `true` | Hidden-tab count on collapsed parents |
| `mod.nestedtabs.close_behavior` | `promote` | `close_all`, `close_collapsed` or `promote` |
| `mod.nestedtabs.caret_position` | `edge` | `edge` (far right, after the close button), `right` (before the close button) or `left` (before the favicon) |

## Debugging

In the Browser Console (Ctrl/Cmd+Shift+J), `gZenNestedTabs` is the live instance. For example, `gZenNestedTabs.normalize()` forces a re-render. Each tab has `_ntId`, `_ntParentId`, `_ntCollapsed` and `_ntPromotions`, and the attributes `nt-depth`, `nt-has-children`, `nt-collapsed` and `nt-hidden`.
