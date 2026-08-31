# Conflict Panel

Find and resolve Syncthing `*.sync-conflict-*` files without leaving Obsidian.

**This plugin never deletes anything.** Resolving a conflict moves the losing copy
into a recovery folder. Emptying that folder is left to you.

Design notes and the reasoning behind that constraint are in
`docs/superpowers/specs/`.

## Install

Not in the community plugin store yet. Install with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from the community plugins browser.
2. **BRAT → Add beta plugin**, and paste `KazeFreeze/obsidian-conflict-panel`.
3. Enable **Conflict Panel** in Community plugins.

BRAT updates it in place afterwards and leaves your settings alone.

Requires Obsidian **1.7.2** or later. The panel opens through `revealLeaf`, which
is what uncollapses a sidebar, and the editor guard reads deferred view state;
neither exists before 1.7.2.

## Status

v0.1.0. Verified in Obsidian 1.13.7 against a fixture vault covering all four
conflict shapes: 8 conflicts resolved, 8 archives created, nothing deleted.
