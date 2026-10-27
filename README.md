# Zen Tab Trees

Tree-style tab nesting for [Zen Browser](https://zen-browser.app), with connector lines for tabs, pinned tabs and folders. A [Sine](https://github.com/CosmoCreeper/Sine) mod.

![Zen Tab Trees: links nesting under their tab, collapsing and reopening a tree](https://raw.githubusercontent.com/vcekron/zen-tab-trees/media/demo.avif)

- Links open as children of the tab they were opened from.
- Collapse a tree with its chevron or by clicking its lines. Closing a collapsed parent closes the whole tree, and one undo brings it back.
- Drag a tab up or down to move it, sideways to change its level; its subtree comes along.

## Install

In Sine's marketplace, install `vcekron/zen-tab-trees` as a custom mod (JS mods need `sine.allow-unsafe-js`).

## Tests

`npm test` (Node 22 or later).

## Credits

- Forked from [Zen Nested Tabs](https://github.com/nigeltroy-gpt0/zen-nested-tabs) by Nigel Thomas Roy, where the tree model and drag and drop started.
- The look of the connector lines comes from [Zen Folder Tree Connectors](https://github.com/JustAdumbPrsn/ZenFolderTreeConnectors) by JustAdumbPrsn.
