# Obsidian Conflict Panel — design (rev 4)

An Obsidian plugin that finds Syncthing `*.sync-conflict-*` files and resolves them **without
leaving Obsidian**. Standalone repo. Desktop and Android, one responsive UI.

## Revision history

- **rev 1** overwrite-in-place plus auto-clear of identical copies.
- **rev 2** a five-step write-new-then-swap transaction. **A mistake** — it invented a transaction to
  compensate for an atomicity guarantee the API already provides, and added a synchronized temp file,
  a deliberate outage of the original path, unwanted link rewriting, and five awaits of exposure.
- **rev 3** `Vault.process` with a hash precondition. Right shape, but overclaimed safety.
- **rev 4** corrects the remaining defects, **cuts per-hunk merge to v0.2**, and adds the
  archive-then-trash recovery folder. Scaffolded from `obsidianmd/obsidian-sample-plugin`.

## v0.1 scope

**In:** detection, grouping, a read-only unified diff, whole-file pick, save-as-new, safe cleanup.

**Out, deferred to v0.2:** per-hunk merge.

Why: the honest size estimate for the full thing is **3,100–5,100 LOC** including tests, of which
per-hunk merge is **800–1,500**. More importantly, per-hunk semantics are *undefined* when a group
has three or more versions — a two-way hunk model does not explain how decisions from three
documents compose or in what order. v0.1 proves the risky infrastructure (detection, grouping, the
open-editor guard, the conditional write, safe cleanup) at roughly a third of the size. Merge is
purely additive afterwards, by which point real conflicts will have shown whether it is needed.

## The write path

```js
// Preflight EVERY input, not just the original. A result derived from a copy that
// changed after review must not be written.
for (const copy of group.copies) {
  if (await readText(copy) !== copy.reviewedText) return abort(copy);
}

// ONE atomic operation. The callback receives current disk content, so the
// precondition is checked INSIDE the atomic section.
await vault.process(original, (current) => {
  if (current !== reviewedOriginalText) throw new StaleInput();
  return result;
});

// Then per copy, each independently guarded so one failure cannot abort the rest.
for (const copy of group.copies) {
  try {
    if (await readText(copy) !== copy.reviewedText) { report(copy); continue; }
    await vault.create(recoveryPath(copy), copy.reviewedText);  // archive first
    await fileManager.trashFile(copy);                          // then trash
  } catch (e) { report(copy, e); }
}
```

**Exact string equality, not SHA-256.** The reviewed text is already retained for diffing, so compare
it directly. Hashing adds a step and a collision argument for no benefit. Use SHA-256 only for
display or persisted identity.

**Archive-then-trash.** `fileManager.trashFile` honours the user's deleted-files preference. When
that preference is **`trashOption: "none"` the deletion is permanent and unrecoverable**, which is a
real configuration and not a hypothetical. The official
`eslint-plugin-obsidianmd` rule nonetheless says to prefer `trashFile` over `Vault.trash`, precisely
*to respect user settings*.

Both are satisfied by archiving first:

```js
await vault.create(recoveryPath(copy), copy.reviewedText);  // survives regardless
await fileManager.trashFile(copy);                          // guideline-compliant
```

The guideline is followed, the user's preference is respected, and the losing side survives even
when that preference is permanent deletion. Every plugin previously praised for "using trash safely"
would permanently delete on this vault.

**Throwing from the `process` callback aborts cleanly.** The adapter has read, `fn` throws, control
never reaches the write, the promise rejects. Not an explicit `@throws` contract in the typings, so
it gets a test against the declared minimum Obsidian version.

## The recovery archive

`.conflict-recovery/<YYYY-MM-DD>/<original-basename>.<device>.<HHMMSS>.md`

**Two traps this must avoid.**

*It must not re-detect itself.* A verbatim copy keeps `.sync-conflict-` in its filename, so the next
scan would find it and offer to resolve a conflict against a file that no longer exists. The archive
therefore renames on write, dropping the suffix, and `core/detect.ts` excludes `.conflict-recovery/`
outright. Belt and braces, because either alone is a single point of failure.

*It must not pile up.* This is the accumulation problem raised early in design. On load the plugin
prunes entries older than **30 days** and reports what it removed, rather than growing without bound
the way `.trash` does.

**It syncs.** Not `.stignore`d, deliberately: a device-local archive is useless when you resolve on
the desktop and only notice the mistake on the laptop, and it would never reach the nightly B2
snapshot. The cost is that recovery files propagate; the 30-day prune bounds it.

## Honest failure behaviour

Rev 3 claimed "exactly one benign ambiguity". That was wrong. The real picture:

| failure point | outcome |
|---|---|
| diff or result construction fails | no write |
| copy preflight fails | no write |
| `StaleInput` or any callback throw | clean abort, no write |
| external write between adapter read and `process` write | **can be overwritten** |
| write rejects, or app dies mid-write | **original may be truncated** |
| `process` succeeds, then app dies | result plus surviving copies, benign |
| copy changes after its check, before trash | **unreviewed content trashed** (recoverable, `.trash`) |
| trash throws on one copy | that copy survives, others still processed |
| later editor autosave lands | **can overwrite the result** |

Three of these are genuinely harmful. They are narrowed, not eliminated, and the spec says so rather
than claiming otherwise.

## The editor guard

The public API exposes no `isDirty`, no pending-autosave status, and no save-generation token;
`dirty`, `unsaved` and `isDirty` appear nowhere in the 1.13.1 typings. There is a reproducible
community report of a pending two-second editor save defeating `process()`.

**Policy: refuse to resolve while any file in the group is open in any editor.** Discover via
`workspace.iterateAllLeaves()`, which includes sidebar and pop-out leaves. Do **not** save-then-
proceed; saving adds a write without making the race impossible. Re-check immediately before
`process` and before each trash.

This cannot discover embedded editors supplied by other plugins, and cannot stop a note being opened
during an awaited operation.

## Architecture

Pure modules hold decision logic and are unit-testable without the Obsidian API. Zync's convention.

**Pure core — no `obsidian` import:**

- `core/detect.ts` — path → `{ originalPath, device, timestamp } | null`.
- `core/group.ts` — file list → `ConflictGroup[]`: one original plus **zero or more** copies. Handles
  several copies of one original, copies of copies, absent originals, no or multiple extensions, and
  legitimate filenames containing `.sync-conflict-`.
- `core/diff.ts` — `jsdiff` wrapper → `Hunk[]`, **for display only in v0.1**.
- `core/entry-view.ts` — group → UI shape and allowed actions. From Zync's `describeInboxEntry`:
  actions derive from SHAPE, and an unrecognised shape falls through to view-only, so a future case
  can never wedge the panel into offering a destructive action.

*(`core/merge.ts` arrives in v0.2.)*

**Obsidian shell:** `main.ts`, `panel-view.ts` (sidebar list + count), `compare-view.ts` (main-tab
diff), `vault-ops.ts` (the only module permitted to write or trash), `notify.ts` from Zync.

## Invariants

1. **One writer.** Only `vault-ops.ts` imports write APIs, enforced by a test. This is a boundary
   check, **not** a concurrency test.
2. **Never `vault.delete`.** Archive to `.conflict-recovery/` first, then `fileManager.trashFile`.
3. **Input-version precondition.** Every destructive act is preceded by an equality check against the
   reviewed text. For the original this happens inside `process`.
4. **Nothing destroyed until the result is written.**
5. **Refuse while any group file is open in an editor.**
6. **Orphans offer three named choices**, never a bare "restore": keep the deletion and save the edit
   as a new note; save under a different name; or recreate the original path, warning explicitly that
   this resurrects it on every device.
7. **Every control has a visible text label**, ≥48dp touch target, adequate separation.
8. **Skip never aborts the batch.** Per-copy `try/catch`.
9. **Decisions persist outside the DOM**, because Android can destroy a view at any await.
10. **Re-entrancy guard.** A resolve in flight blocks another for the same group.

## Labels

Not "yours" and "theirs". Syncthing renames *the file with the older modification time*, breaking
ties on device-ID ordering, so the file keeping the original name is whichever was newer, not
whichever is local. The UI states what happened: `note.md · kept` and `copy · from <device>, 14:32`.

## Platform

`isDesktopOnly: false`. **`minAppVersion: 1.6.6`** — required by the trash APIs, not the 1.1.0 of
`Vault.process`.

- SHA-256 via **Web Crypto**. No Node `crypto`, `Buffer`, `fs`, `path`, or `FileSystemAdapter`.
- Diffing bounded and yielding, so a pathological diff cannot block the WebView until Android kills it.
- Binary conflicts **listed with provenance** and offered save-as-new. Not "reveal in explorer".

## Non-goals

- No Syncthing REST API. Filename detection only — works offline, no API key, and this is what makes
  Android viable.
- No three-way merge. Syncthing provides no common ancestor.
- No auto-resolution. Auto-clear was **cut**: Syncthing's docs state a copy is created only when
  content *"actually differs"*, so it would fire approximately never.
- **Save-as-new leaves the conflict copy in place**, so the next scan rediscovers it. Intentional in
  v0.1: that action destroys nothing.

## Testing

Vitest over every `core/` module, named cases per invariant. `vault-ops.ts` against a fake adapter.

**Stated limitation:** a fake adapter cannot prove atomicity, rename races, cache invalidation,
editor behaviour, Android process death, or simultaneous resolution on two devices. Those need fault
injection at each await and a two-peer integration test.

## Deferred

- Per-hunk merge (v0.2), including defining multi-copy semantics.
- Trashed copies accumulate in `.trash` and nothing prunes them.
- The B2 backup's `--backup-dir` archive grows daily with no pruning.
