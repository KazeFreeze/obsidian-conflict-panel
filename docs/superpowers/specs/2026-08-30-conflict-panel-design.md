# Obsidian Conflict Panel — design (rev 6)

An Obsidian plugin that finds Syncthing `*.sync-conflict-*` files and resolves them **without
leaving Obsidian**. Standalone repo. Desktop and Android, one responsive UI.

## The property that defines v0.1

**The plugin calls no deletion API.** Not `vault.delete`, not `vault.trash`, not
`fileManager.trashFile`. Cleanup is a single `vault.rename` that moves the conflict copy into a
recovery folder.

This is not caution for its own sake. Five shipped plugins were audited against source and three had
real data-loss paths. Every one of them was in a delete call. A plugin that cannot delete cannot lose
your notes.

## Revision history

Five audits. Two revisions were structurally wrong and are recorded so the mistakes are not repeated.

- **rev 1** auto-cleared byte-identical copies. Syncthing only creates a copy when content *actually
  differs*, so it would fire approximately never.
- **rev 2** replaced overwrite-in-place with a five-step write-new-then-swap transaction. Worse than
  the problem: `Vault.process` is already documented as an atomic read-modify-save, and the
  transaction added a synced temp file, an outage of the original path, and link rewriting.
- **rev 3** used `Vault.process` correctly but claimed an editor-dirty guard the public API cannot
  back, and a resumability property that does not hold.
- **rev 4** used one write path for five different actions, and put the archive in a dot-folder the
  Vault API cannot manage.
- **rev 5** fixed both, but kept archive-then-trash, which has a real data-loss window: the check
  passes on content A, A is archived, another writer changes the copy to B, `trashFile` deletes B. On
  a vault configured `trashOption: "none"` that is permanent. A second check narrows the window and
  cannot close it.
- **rev 6** replaces copy-then-delete with a single move. The losing file is *preserved*, not copied,
  so the window cannot exist.

## v0.1 scope

**In:** detection, grouping, a read-only unified diff, whole-file pick, save-as-new, cleanup by move.

**Out:** per-hunk merge, pruning, retention policy, operation IDs, sync controls, any deletion.

Per-hunk merge is deferred because the honest estimate for the full design was 3,100–5,100 LOC with
merge at 800–1,500 of it, and because two-way hunks have no defined semantics when a group holds
three or more versions. It is **not** purely additive: it changes result construction, decision
state, the compare view, and forces the multi-copy question v0.1 avoids.

## The action matrix

Authoritative. Earlier revisions contradicted themselves by describing actions in two places.

**Original present**, one or more copies:

| action | original | copies |
|---|---|---|
| Keep the original | untouched | all moved to recovery |
| Keep copy *X* | content replaced with *X* via `vault.process` | all moved to recovery |
| Save copy *X* as a new note | untouched | **untouched** — nothing is resolved |
| Do nothing | untouched | untouched |

**Original absent** (Syncthing's edit-versus-delete), one or more copies:

| action | result |
|---|---|
| Restore copy *X* to the original path | `vault.rename` *X* onto the original path. **Warned explicitly:** this resurrects a file another device deliberately deleted, and Syncthing propagates that resurrection everywhere. Remaining copies move to recovery. |
| Accept the deletion | all copies moved to recovery |
| Do nothing | untouched |

With several copies the user picks **one** *X*. There is no "save them all"; the rest are preserved
in recovery and can be retrieved by hand.

## Write paths

Only **two** actions touch an existing file. Everything else is a move or a create.

```js
// Only when replacing the original's content with a chosen copy.
await vault.process(original, (current) => {
  if (current !== reviewedOriginalText) throw new StaleInput();
  return chosenText;
});

// Cleanup: one move per copy, independently guarded. No deletion anywhere.
for (const copy of group.copies) {
  try {
    await ensureFolder(recoveryFolderFor(copy));
    await vault.rename(copy, recoveryPathFor(copy));
  } catch (e) { report(copy, e); }
}
```

**Exact string equality, not SHA-256.** The reviewed text is already retained for the diff.

**`vault.rename`, not `fileManager.renameFile`.** The latter rewrites links according to user
preference, which is wrong here: the note is not being renamed, a conflict artifact is being filed
away. Link rewriting would edit unrelated notes.

**There is no transaction across the original and the copies.** If the original is replaced and a
move then fails, the vault holds a resolved original and an unmoved copy. Reported, not prevented,
and harmless because nothing was destroyed.

**Throwing from the `process` callback aborts cleanly** — the adapter has read, `fn` throws, control
never reaches the write. This is not an explicit `@throws` contract, so it needs an integration
fixture against a real Obsidian at the minimum version. A fake adapter cannot establish it.

## The recovery folder

Default `Conflict Recovery/`, configurable. **Visible and Vault-managed**, because dot-directories
are hidden from Obsidian's loaded vault tree and require the Adapter API — the same reason conflicts
inside `.obsidian/` are invisible to every plugin surveyed.

**Archived files get a non-note extension**, `.conflictbak`. Obsidian treats unknown extensions as
unsupported files: visible in the explorer, absent from search, the graph, backlinks, Dataview, and
any template that globs the vault. Without this, a bad week of conflicts would drop dozens of
near-duplicate notes into exactly the tools used to find things.

**Names encode a hash of the full source path**, not the basename, because two `note.md` in different
folders would otherwise collide in a single batch. Parent folders are created explicitly; neither
`vault.create` nor `vault.rename` creates them.

**Nothing prunes it.** No retention, no automatic deletion, no clock-skew hazard, and no need to tell
a user's note apart from an artifact. The folder grows and the user empties it by hand whenever they
like. A deliberate trade: unbounded growth in exchange for a plugin that cannot delete.

**It syncs**, like any vault folder, so recovery is available on whichever device notices the mistake
and reaches the nightly offsite snapshot. The cost is that losing versions replicate to every peer,
and a conflict storm consumes real storage on a phone. Emptying the folder is the mitigation.

## Detection and grouping

`core/group.ts` returns `ConflictGroup[]` where `original: TFile | null` and `copies` holds at least
one entry. The null case is the orphan.

**Copy-of-a-copy resolves recursively.** `note.sync-conflict-A.sync-conflict-B.md` strips suffixes
until a stable base remains, and all descendants attach to that one original.

**Re-detection is prevented by folder exclusion, not by the extension.** `core/detect.ts` normalises
the path and rejects the recovery root outright. The non-note extension is defence in depth: an
ordinary note can legitimately contain a valid-looking `.sync-conflict-*` sequence, especially with
multiple extensions, so filename rules alone are insufficient. A Syncthing conflict *of an archived
file* stays inside the excluded folder and is excluded too. Regression test required.

## Honest failure behaviour

| failure point | outcome |
|---|---|
| diff or result construction fails | nothing written |
| `StaleInput` or any callback throw | clean abort, nothing written |
| external write between adapter read and `process` write | **can be overwritten** |
| write rejects, or app dies mid-write | **original may be truncated** |
| `process` succeeds, then app dies | resolved original, copies unmoved — benign, rediscovered |
| a copy changes between review and move | the *current* content is moved, not the reviewed content |
| `rename` throws on one copy | that copy stays, others still processed |
| later editor autosave lands | **can overwrite the result** |

Three are genuinely harmful and all three are writes, not deletes. They are narrowed, not
eliminated. Note rows five and six: because cleanup moves rather than deletes, an interrupted or
racing cleanup **cannot lose content**. Worst case a file is filed away holding something newer than
what was reviewed, and it is still sitting there to read.

## The editor guard

The public API exposes no `isDirty`, no pending-autosave status, and no save-generation token;
`dirty`, `unsaved` and `isDirty` appear nowhere in the 1.13.1 typings. There is a reproducible
community report of a pending two-second editor save defeating `process()`.

**Policy: refuse while any file in the group is open in any editor.** Discovered via
`workspace.iterateAllLeaves()`, which includes sidebar and pop-out leaves. Do not save-then-proceed;
saving adds a write without making the race impossible. Re-check immediately before `process`.

This cannot discover embedded editors from other plugins, nor stop a note being opened mid-operation.

## Architecture

Pure modules hold decision logic and are testable without the Obsidian API.

**Pure core — no `obsidian` import:** `detect.ts` (path → parsed conflict or null), `group.ts` (files
→ groups, recursive), `diff.ts` (jsdiff → hunks, display only), `entry-view.ts` (group → UI shape and
allowed actions; actions derive from SHAPE, and an unrecognised shape falls through to view-only so a
future case cannot wedge the panel into offering a destructive action).

**Obsidian shell:** `main.ts`, `panel-view.ts` (sidebar list and count), `compare-view.ts` (main-tab
diff), `vault-ops.ts` (the only module permitted to write, move or create), `notify.ts`.

## Invariants

1. **One writer.** Only `vault-ops.ts` imports mutating APIs, enforced by a test. A boundary check,
   **not** a concurrency test.
2. **No deletion API is called anywhere in the plugin.** Enforced by the same test.
3. **Input-version precondition.** The only content replacement checks equality against the reviewed
   text, inside `process`.
4. **Cleanup preserves.** Copies are moved, never copied-then-removed.
5. **Refuse while any group file is open in an editor.**
6. **Resurrection is warned.** Restoring an orphan copy to its original path states plainly that it
   propagates to every device.
7. **Every control has a visible text label**, ≥48dp touch target, adequate separation.
8. **One failure never aborts the batch.** Per-copy `try/catch`.
9. **Decisions persist outside the DOM**, because Android can destroy a view at any await.
10. **Re-entrancy guard.** A resolve in flight blocks another for the same group.

## Labels

Not "yours" and "theirs". Syncthing renames *the file with the older modification time*, breaking
ties on device-ID ordering, so the file keeping the original name is whichever was newer, not
whichever is local. The UI states what happened: `note.md · kept` and `copy · device 7GIIEBZ, 14:32`.

`modifiedBy` is a **short device ID**, not the friendly name set in the Syncthing UI. Without the
REST API there is no mapping, so the UI must not imply one.

## Platform

`isDesktopOnly: false`. `minAppVersion` follows the highest API actually used; `Vault.process`
requires 1.1.0, and no trash API is used at all.

- SHA-256 via **Web Crypto** for archive names. No Node `crypto`, `Buffer`, `fs`, `path`, or
  `FileSystemAdapter`.
- Diffing bounded and yielding, so a pathological diff cannot block the WebView until Android kills it.
- Binary conflicts are **listed with provenance** and can be moved to recovery, but not diffed.

## Non-goals

- No Syncthing REST API. Filename detection only — works offline, needs no API key, and this is what
  makes Android viable.
- No three-way merge. Syncthing provides no common ancestor.
- No auto-resolution of any kind.
- **Save-as-new resolves nothing.** It creates a note and leaves both inputs in place, so the group is
  rediscovered on the next scan. Intentional, and stated in the UI.

## Testing

Vitest over every `core/` module, named cases per invariant, including recursive copy-of-copy
grouping and nested recovery-folder filenames.

**Stated limitation:** a fake adapter cannot prove rename atomicity, cache invalidation, editor
behaviour, Android process death, or two devices resolving at once. Those need fault injection and a
two-peer integration fixture. The one-writer and no-delete greps are boundary checks, not concurrency
tests.

## Deferred

- Per-hunk merge (v0.2), including defining multi-copy semantics.
- Emptying the recovery folder is manual. No retention exists, by design.
