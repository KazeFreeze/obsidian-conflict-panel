# Obsidian Conflict Panel — design (rev 5)

An Obsidian plugin that finds Syncthing `*.sync-conflict-*` files and resolves them **without
leaving Obsidian**. Standalone repo. Desktop and Android, one responsive UI.

## Revision history

- **rev 1** overwrite-in-place plus auto-clear of identical copies.
- **rev 2** a five-step write-new-then-swap transaction. **A mistake** — it invented a transaction to
  compensate for an atomicity guarantee the API already provides, and added a synchronized temp file,
  a deliberate outage of the original path, unwanted link rewriting, and five awaits of exposure.
- **rev 3** `Vault.process` with a hash precondition. Right shape, but overclaimed safety.
- **rev 4** cut per-hunk merge to v0.2 and added archive-then-trash. But it kept **one write path
  for five different actions**, and put the archive in a dot-folder that the Vault API cannot manage.
- **rev 5** branches the write path per action, moves the archive to a visible Vault-managed folder,
  and makes archive location a setting rather than a claimed safety rule.

## v0.1 scope

**In:** detection, grouping, a read-only unified diff, whole-file pick, save-as-new, safe cleanup.

**Out, deferred to v0.2:** per-hunk merge.

Why: the honest size estimate for the full thing is **3,100–5,100 LOC** including tests, of which
per-hunk merge is **800–1,500**. More importantly, per-hunk semantics are *undefined* when a group
has three or more versions — a two-way hunk model does not explain how decisions from three
documents compose or in what order. v0.1 proves the risky infrastructure (detection, grouping, the
open-editor guard, the conditional write, safe cleanup) at roughly a third of the size.

Merge is **not** purely additive, and rev 4 overclaimed by saying so. It changes result construction,
per-hunk decision state, the compare view, validation, and it forces a decision on multi-copy
semantics that v0.1 sidesteps entirely. Deferring it is still right, but v0.2 is a real design
increment rather than a bolt-on.

## Write paths, one per action

Rev 4's single pseudocode path was wrong: it routed every action through `vault.process(original)`,
including actions that write nothing and one that has no original to pass. Each action gets its own
path, and **only two of the five write to an existing file.**

| action | writes original? | archives + cleans copies? |
|---|---|---|
| Keep the original | **no** | yes |
| Keep a copy | yes, `vault.process` | yes |
| Save as a new note | no | **no** — see below |
| Orphan: recreate original | `vault.create`, not `process` | yes |
| Orphan: keep the deletion | no | yes |

"Keep the original" needing no write at all is the important correction. Rev 4 exposed it to the
truncation and overwrite risks in the failure table for no reason.

```js
// Only when replacing the original's content.
await vault.process(original, (current) => {
  if (current !== reviewedOriginalText) throw new StaleInput();
  return chosenText;
});

// Cleanup, per copy, each independently guarded.
for (const copy of group.copies) {
  try {
    if (await readText(copy) !== copy.reviewedText) { report(copy); continue; }
    await archive(copy);                  // idempotent, see below
    await fileManager.trashFile(copy);
  } catch (e) { report(copy, e); }
}
```

**Exact string equality, not SHA-256.** The reviewed text is already retained for the diff. Hashing
adds a step and a collision argument for no benefit; use SHA-256 only for archive identity.

**There is no transaction across the original and the copies.** If the original is replaced and a
copy then fails its check, the vault holds a result derived from an input that has since changed.
Nothing can prevent this without a lock the API does not offer. It is reported, not prevented.

**Archive-then-trash.** `fileManager.trashFile` honours the user's deleted-files preference. When
that preference is `trashOption: "none"` the deletion is **permanent and unrecoverable**, which is a
real configuration and not a hypothetical. The official `eslint-plugin-obsidianmd` rule nonetheless
prefers `trashFile` precisely *to respect user settings*. Archiving first satisfies both: the
guideline is followed, the preference is respected, and the losing side survives regardless.

**Throwing from the `process` callback aborts cleanly** — the adapter has read, `fn` throws, control
never reaches the write. This is not an explicit `@throws` contract in the typings, so it needs an
integration fixture against a real Obsidian at the declared minimum version. A fake adapter cannot
establish it.

## The recovery archive

**A visible folder, not a dot-folder.** Rev 4 specified `.conflict-recovery/`. Dot-directories are
hidden from Obsidian's loaded vault tree and require the Adapter API, which is the same reason
conflicts inside `.obsidian/` are invisible to every plugin surveyed. A visible folder is
Vault-managed, so `getFiles()`, `create` and pruning all work normally.

Default `Conflict Recovery/`, **configurable**, including an option to disable archiving for users
who would rather not have losing versions replicated.

**Naming must encode the full path, not the basename.** Two `note.md` files in different folders
would collide during a single batch. The archive name carries a short hash of the source path plus a
collision suffix, and the plugin creates parent folders explicitly because `vault.create` does not.

**Idempotent, because create-then-trash is not atomic.** If archiving succeeds and trashing fails,
both files survive and a retry must not duplicate. Each resolution carries a stable operation ID; an
existing archive with a matching ID and identical content means "already archived, continue to
cleanup" rather than "write another one".

**Re-detection is prevented by folder exclusion, not by renaming.** `core/detect.ts` normalises the
path and rejects the archive root outright. Renaming on write is defence in depth only: an ordinary
note can legitimately contain a syntactically valid `.sync-conflict-*` sequence, especially with
multiple extensions, so renaming alone would not be sufficient. A Syncthing conflict *of an archive
file* stays inside the excluded folder and is therefore also excluded. Regression test required for
nested archive conflict filenames.

**Pruning is best-effort and bounds age, not size.** Entries older than 30 days are removed on load.
This does **not** bound bytes, item count, or `.trash` growth, and rev 4 implied otherwise. Pruning
skips malformed and future-dated entries, because clock skew on any synced device would otherwise
delete fresh archives and propagate those deletions everywhere. It records partial failures and
removes empty folders. Pruning deletes through the adapter rather than `trashFile`, which is an
explicit and deliberate exception to the deletion policy — otherwise pruning merely relocates the
problem into `.trash`.

**Syncing the archive is a choice with real costs**, not a universal safety rule. Replicating it
means recovery is available on the device where you notice the mistake and reaches the nightly
offsite snapshot. It also means every losing version propagates to every peer, a conflict storm can
consume real storage on a phone, concurrent archive writes can themselves produce conflict copies,
and prune churn propagates too. Hence: a setting, defaulting to synced, documented plainly.

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
- `core/group.ts` — file list → `ConflictGroup[]`, where `original: TFile | null` and `copies` has at
  least one entry. The null case is the orphan, and the type must say so; rev 4 said "one original"
  while also handling absent ones. Handles several copies of one original, copies of copies, no or
  multiple extensions, and legitimate filenames containing `.sync-conflict-`.
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
2. **Never `vault.delete`** for user content. Archive to the recovery folder first, then
   `fileManager.trashFile`. Adapter-level deletion is permitted in exactly one place: pruning the
   archive itself, which is stated as a deliberate exception.
3. **Input-version precondition.** Every destructive act is preceded by an equality check against the
   reviewed text. For the original this happens inside `process`.
4. **Nothing destroyed until the result is written.**
5. **Refuse while any group file is open in an editor.**
6. **Orphans offer two named choices**, never a bare "restore": save the surviving edit as a new
   note and let the deletion stand; or recreate the original path, warning explicitly that this
   resurrects the file on every device. Rev 4 listed three, but two of them were the same action
   described twice.
7. **Every control has a visible text label**, ≥48dp touch target, adequate separation.
8. **Skip never aborts the batch.** Per-copy `try/catch`.
9. **Decisions persist outside the DOM**, because Android can destroy a view at any await.
10. **Re-entrancy guard.** A resolve in flight blocks another for the same group.

## Labels

Not "yours" and "theirs". Syncthing renames *the file with the older modification time*, breaking
ties on device-ID ordering, so the file keeping the original name is whichever was newer, not
whichever is local. The UI states what happened: `note.md · kept` and
`copy · device 7GIIEBZ, 14:32`.

The `modifiedBy` field in a Syncthing conflict filename is a **short device ID**, not the friendly
name you set in the Syncthing UI. Without the REST API there is no mapping between them, so the UI
must say "device <id>" rather than imply a name it cannot know.

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
