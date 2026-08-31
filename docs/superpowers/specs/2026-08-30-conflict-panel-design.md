# Obsidian Conflict Panel — design (rev 8)

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
- **rev 6** replaced copy-then-delete with a single move. The losing file is *preserved*, not copied,
  so that window cannot exist. Audit six confirmed the rev-5 hole is closed and endorsed dropping
  pruning, but found five gaps an implementer would have had to invent answers for.
- **rev 7** closed them, but its Recovery list was **circular**: it promised a reader for files the
  same document said might stop being Vault-manageable. It also left the binary classifier, the
  shape precedence, and restore semantics unstated.
- **rev 8** resolves all four. The recovery folder is **Adapter-managed**, which is setting-
  independent and sees unloaded files; the binary rule is extension-based with no sniffing; shape
  precedence is ordered; restore is defined as a move with the original extension recovered from the
  archive name.

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
| Restore copy *X* to the original path | Read *X*, atomically create the original with `vault.create`, then move *X* to recovery. **Warned explicitly:** this resurrects a file another device deliberately deleted, and Syncthing propagates that resurrection everywhere. Remaining copies move to recovery. |
| Accept the deletion | all copies moved to recovery |
| Do nothing | untouched |

With several copies the user picks **one** *X*. There is no "save them all"; the rest are preserved
in recovery and can be retrieved by hand.

**An orphan whose original reappears mid-decision aborts.** See the no-clobber rule.

**Opaque groups are move-only in v0.1.** `Vault.process` is text-only and there is no binary
equivalent, so "keep copy *X*" would require an unguarded `modifyBinary` with no version
precondition. Rather than invent that, opaque groups offer exactly two actions: move copies to
recovery, or do nothing. Listed with full provenance, never diffed.

**The classifier is extension-based, with no content sniffing: `.md` is diffable, everything else is
opaque.** Sniffing needs an exact rule and a binary-capable read path, and gets `.canvas` wrong in
both directions — it is UTF-8 JSON, but diffing it as text produces a meaningless hunk list. Treating
it as opaque is conservative and correct. A `.md` file containing binary bytes is the one case this
rule mishandles; it is pathological under Syncthing and is accepted rather than solved.

**Shape precedence, highest first:** canonical path holds a folder → view-only. Otherwise extension
is not `.md` → opaque, move-only. Otherwise original absent → orphan. Otherwise → normal. Stated as
an order because a binary conflict whose canonical path is a folder matches two rules at once.

**A canonical path occupied by a folder is a distinct shape.** `original: TFile | null` collapses
"path is free" and "path holds a `TFolder`", and restoring onto the latter would attempt to rename a
file over a directory. The group type carries a third state, rendered view-only with an explanation.

## Write paths

Only **two** actions touch an existing file. Everything else is a move or a create.

```js
// Only when replacing the original's content with a chosen copy. Text only.
await vault.process(original, (current) => {
  if (current !== reviewedOriginalText) throw new StaleInput();
  return chosenText;
});

// Cleanup: one move per copy, independently guarded. No deletion anywhere.
for (const copy of group.copies) {
  try {
    await ensureFolder(recoveryFolderFor(copy));
    await vault.rename(copy, await freePathNear(recoveryPathFor(copy)));
  } catch (e) { report(copy, e); }
}
```

**No-clobber is mandatory for restoration.** `Vault.create(path, data)` is the public atomic
no-clobber primitive: it throws if the original path is occupied. Restore therefore reads the copy,
recognises a destination that is already occupied, creates the original, and only then archives the
copy. The lookup never authorises the write: `create` remains the sole safety guard, so a destination
that appears after lookup still makes create fail without clobbering it. A confirmed existing file or
folder becomes `DestinationOccupied`; a create failure changes nothing; an archive failure after
create leaves a duplicate. Every occupied destination aborts, including a file with identical bytes
and `restoreTo(copy, copy.path)`; byte equality cannot prove that this plugin created the file.

If creation succeeds and archival fails, `RestoreArchiveFailed` carries `originalPath`, `copyPath`,
and the raw cause. Its message leads with the known outcome: restoration succeeded, both files are
still present, and nothing was lost. The user can move or delete the conflict copy manually. There is
no automatic retry because safely proving provenance would require durable operation state.

**Create-error classification is limited by the public API.** Obsidian exposes no typed create
error. If lookup saw an empty path and `create` then fails, callers cannot reliably distinguish a
race-created destination from permissions or an invalid path. The raw cause is preserved rather than
guessed, and the UI must not claim a specific cause for that failure.

Recovery archival still uses a checked `vault.rename`, whose contract does not promise no-clobber.
The Adapter check sees unloaded artifacts and narrows the window, but cannot close it. A concurrent
archive can occupy the checked destination before rename, and the rename may overwrite that
**previously archived losing version**. That is real data loss even though the current copy survives.

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

**Archived files get a non-note extension**, `.conflictbak`. Obsidian does not treat unknown
extensions as notes, so they stay out of content search, backlinks, the graph, and Dataview, which
indexes only `.md` and `.markdown`. Without this, a bad week of conflicts would drop dozens of
near-duplicate notes into exactly the tools used to find things.

Two claims rev 6 made about this were **wrong** and are corrected here:

*They are not unconditionally visible.* Obsidian shows unsupported files in the File Explorer and
Quick Switcher only when **Show all file types** is enabled. With it off they may also stop being
Vault-manageable after a restart, since the Vault API only exposes files loaded into the visible tree.

*They are not hidden from everything.* Any plugin or template using `vault.getFiles()`, adapter
listing, or raw filesystem access still sees them. "Absent from any template that globs the vault"
was false.

**The recovery folder is Adapter-managed, and this is the one place the plugin uses `DataAdapter`.**

Rev 7 promised an in-plugin reader while also stating that unsupported files may stop being
Vault-manageable after a restart. Those cannot both hold: a `TFile`-based reader cannot enumerate
files that are not in the vault tree. `vault.adapter` (`list`, `read`, `readBinary`, `exists`,
`rename`) works on paths rather than `TFile`s, so it is **independent of Show all file types** and of
whether Obsidian loaded the file.

The rest of the plugin stays Vault-managed. The Adapter is scoped to exactly one directory, which is
also what makes the destination check useful: `adapter.stat()` sees and identifies an unloaded
`.conflictbak` that `getAbstractFileByPath()` would miss and report as free.

**Restore creates, then archives.** For Markdown orphans, it reads the conflict copy, calls
`vault.create` at the original path, and only after that succeeds moves the copy to recovery. If the
path is occupied, create aborts atomically. If archival then fails, both copies remain. Opaque groups
do not offer restore in v0.1.

**Index staleness is accepted, not solved.** Renaming `.md` to an unsupported extension does not
reliably evict the old entry: Dataview's rename handler returns early when the new path is not
Markdown, so a stale entry can survive until reinitialisation. The panel says so rather than
pretending the transition is clean.

**Names encode the full source path reversibly**, not the basename, because two `note.md` in
different folders would otherwise collide in a single batch.

Rev 8 said "a hash of the full source path" here while also requiring restore to *reconstruct* the
original path from the name. **A hash is not reversible, so those two requirements contradicted each
other**, and six adversarial audits missed it. It was caught during implementation.

The encoding is percent-style: `%` becomes `%25` first, then `/` becomes `%2F`. Escaping the escape
character first is what makes it unambiguous — a naive `/` → `__` flattening collides, since
`a__b/note.md` and `a/b__note.md` produce the same string. Restore decodes in reverse. The encoded
archive basename is measured with `TextEncoder` and rejected with a dedicated error above 255 UTF-8
bytes, before any adapter rename is attempted.

The first archive uses `Conflict Recovery/<encoded>.conflictbak`. Collisions keep that basename
unchanged and move the counter into a subfolder: `Conflict Recovery/2/<encoded>.conflictbak`, then
`Conflict Recovery/3/...`, and so on. This avoids both ambiguous filename markers and a collision
suffix pushing an otherwise valid basename over the filesystem component limit. Restore decodes
only the final basename, so collision 10 cannot alias collision 1 and literal `%` or `%00` in the
source path round-trip unchanged. Every existing path component is checked with `adapter.stat()`:
a regular file named `2` is not mistaken for a collision folder, so that bucket is skipped, and a
regular file blocking any configured parent makes folder creation fail without moving the copy.

Parent folders are created explicitly; neither `vault.create` nor `vault.rename` creates them.

**Nothing prunes it.** No retention, no automatic deletion, no clock-skew hazard, and no need to tell
a user's note apart from an artifact. The folder grows and the user empties it by hand whenever they
like. A deliberate trade: unbounded growth in exchange for a plugin that cannot delete.

The residual risk is storage, not loss. A conflict storm replicated to a phone can fill it, and a
full disk makes unrelated Obsidian and Syncthing writes fail. The panel therefore **reports recovery
count and total size** so the folder cannot grow unnoticed, and the Recovery list is where you clear
it. Automatic deletion is still not worth reintroducing.

**It syncs**, like any vault folder, so recovery is available on whichever device notices the mistake
and reaches the nightly offsite snapshot. The cost is that losing versions replicate to every peer,
and a conflict storm consumes real storage on a phone. Emptying the folder is the mitigation.

## Detection and grouping

`core/group.ts` returns `ConflictGroup[]` where `original: TFile | null` and `copies` holds at least
one entry. The null case is the orphan.

**Copy-of-a-copy resolves recursively.** `note.sync-conflict-A.sync-conflict-B.md` strips suffixes
until a stable base remains, and all descendants attach to that one original.

**This is deterministic but not always correct, and the spec does not pretend otherwise.** A note
*deliberately named* `incident.sync-conflict-20260829-120000-ABCDEF2.md` is indistinguishable, by
filename alone, from a conflict copy of `incident.md`. Recursive stripping would wrongly attach its
own conflict copy to `incident.md`. No filename-only algorithm can resolve this, and without the
Syncthing REST API there is no other signal. Every group therefore offers **view-only, do not
group** as an escape hatch, and grouping is never acted on without the user seeing which files were
paired.

**Re-detection is prevented by folder exclusion, not by the extension.** The recovery-folder setting
is normalized once when loaded or changed: Obsidian's `normalizePath` handles its actual separator,
surrounding-slash, whitespace, and Unicode behavior, then the plugin explicitly removes empty and
`.` path segments. The resulting canonical value is passed unchanged to grouping, folder creation,
and archive naming. This handles leading or repeated separators, `.` segments, and backslashes
without assuming undocumented behavior from Obsidian or letting three implementations disagree.
`core/group.ts` rejects that recovery root outright. The non-note extension is defence in depth: an
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
| restore create finds an occupied original | clean abort, copy untouched |
| restore create fails after an empty lookup | clean abort with raw, unclassified cause; copy untouched |
| restore create succeeds, then archive fails | `RestoreArchiveFailed`; original and copy both remain, nothing lost; manual cleanup |
| a copy changes between review and move | the *current* content is moved, not the reviewed content |
| `rename` throws on one copy | that copy stays, others still processed |
| recovery destination appears after its check | **previously archived losing version can be overwritten** |
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

1. **One writer.** Only `vault-ops.ts` imports mutating APIs. A source-spelling guard catches common
   literal violations; it is not proof and not a concurrency test.
2. **No deletion API is called anywhere in the plugin.** The same kind of spelling guard supplements
   review but cannot detect every alias or computed access.
3. **Input-version precondition.** The only content replacement checks equality against the reviewed
   text, inside `process`.
4. **Cleanup preserves.** Copies are moved, never copied-then-removed.
5. **Restoration is atomic no-clobber.** `vault.create` fails if the original is occupied. Recovery
   rename destinations are checked, but their check-to-rename race remains and is documented.
6. **Refuse while any group file is open in an editor.**
7. **Resurrection is warned.** Restoring an orphan copy to its original path states plainly that it
   propagates to every device.
8. **Every control has a visible text label**, ≥48dp touch target, adequate separation.
9. **One failure never aborts the batch.** Per-copy `try/catch`.
10. **Decisions persist outside the DOM**, because Android can destroy a view at any await.
11. **Re-entrancy guard.** A resolve in flight blocks another for the same group.

## Labels

Not "yours" and "theirs". Syncthing renames *the file with the older modification time*, breaking
ties on device-ID ordering, so the file keeping the original name is whichever was newer, not
whichever is local. The UI states what happened: `note.md · kept` and `copy · device 7GIIEBZ, 14:32`.

`modifiedBy` is a **short device ID**, not the friendly name set in the Syncthing UI. Without the
REST API there is no mapping, so the UI must not imply one.

## Platform

`isDesktopOnly: false`. `minAppVersion` follows the highest API actually used; `Vault.process`
requires 1.1.0, and no trash API is used at all.

- **No hashing is used anywhere.** Archive names are reversibly percent-encoded, because restore
  has to reconstruct the source path from the name. An earlier revision required SHA-256 here and
  that requirement is withdrawn; it contradicted the recovery section two pages earlier.
- No Node `crypto`, `Buffer`, `fs`, `path`, or `FileSystemAdapter`.
- Diffing is bounded but synchronous and blocking. Inputs above 100,000 UTF-16 code units or 1,000
  displayed lines are rejected before jsdiff; a terminal newline does not count as an extra empty
  line. Accepted worst-case input has a 500ms regression budget.
  This is not cooperative yielding: the compare-view plan inherits a known limitation and must not
  call `toHunks` on the main thread for accepted-but-large input without an additional UI guard.
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
grouping. Vault-operation tests use an in-memory path → content model and assert the exact content at
the original, copy, and recovery paths after success and failure. They also assert every returned
move-result field by object identity, preserve the exact raw archival error, and re-check all older
collision archives after writing the new one; statuses or call counts alone are insufficient.

**Stated limitation:** a fake adapter cannot prove rename atomicity, cache invalidation, editor
behaviour, Android process death, or two devices resolving at once. Those need fault injection and a
two-peer integration fixture. The one-writer and no-delete greps are boundary checks, not concurrency
tests.

## Deferred

- Per-hunk merge (v0.2), including defining multi-copy semantics.
- Emptying the recovery folder is manual. No retention exists, by design.
