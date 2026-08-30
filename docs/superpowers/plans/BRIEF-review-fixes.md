# Brief: fix the seven findings from independent review

An independent reviewer read the six commits you wrote. Seven findings, ranked below by what
to fix first. Most are bugs in the plan I gave you, not in your execution.

Work through them **in this order**, committing each separately. The plan is now at
`docs/superpowers/plans/2026-08-30-conflict-panel-core.md` (renamed, since it is the core
phase and not v0.1). The spec at `docs/superpowers/specs/2026-08-30-conflict-panel-design.md`
remains the authority.

Fix the code **and** the corresponding snippet in the plan, so the plan stops being wrong.

---

## 1. The diff cap does not bound computation

`src/core/diff.ts` calls `diffLines(left, right)` **to completion**, then caps the hunks it
returns. Capping output does not limit work. The spec requires diffing to be "bounded and
yielding, so a pathological diff cannot block the WebView long enough for Android to kill the
app", and this satisfies neither.

The evidence is already in the suite: the hunk-cap test takes **4.3 seconds**. It exists to
prove the guard works and instead demonstrates it does not.

Bound the *input* before diffing. Suggested: if either side exceeds a line count or byte size
threshold, return a sentinel that the UI renders as "too large to compare here" rather than
attempting the diff. Add a test asserting the pathological case returns in well under a second.

## 2. Encode/decode is not reversible under collision

`recoveryPathFor()` encodes `a/b/note.md` to `a%2Fb%2Fnote.md.conflictbak`, which decodes
correctly. But `freePath()` disambiguates a collision to `a%2Fb%2Fnote.md-2.conflictbak`, and
that decodes to `a/b/note.md-2` — a path that never existed.

`sourcePathFromRecovery()` also does not strip the recovery-folder prefix, so feeding it the
full output of `recoveryPathFor()` returns a path with the folder still attached.

Make the decoder the exact inverse of the actual generator, collision suffix and folder prefix
included. Add a round-trip property test that covers the collision case, not just the happy one.

## 3. `restoreTo` is still a check-then-rename race

`adapter.exists()` then `vault.rename()` leaves a window where Syncthing can recreate the
original, and `Vault.rename` has no documented no-clobber guarantee, so the rename may
overwrite a note nobody reviewed. The spec calls this rule **mandatory** for restoration.

The window cannot be closed with the public API. Narrow it as far as possible: re-check
immediately before the rename, and document the residual race honestly in both the code
comment and the spec's failure table rather than implying it is closed.

The same race exists in `freePath` → recovery rename, but the spec explicitly accepts that
one, because a collision there costs a duplicate artifact rather than data. Leave it, and say
so in the comment.

## 4. `ensureFolder` does not create nested parents

One `adapter.mkdir("a/b/c")` call. `DataAdapter.mkdir` does not promise recursive creation,
and `recoveryFolder` is a free-text setting, so `Archive/Conflicts/2026` is reachable. Create
each path segment in turn. Add a test.

## 5. A trailing slash defeats the recovery exclusion entirely

In `src/core/group.ts`, `recoveryFolder = "Conflict Recovery/"` produces the prefix
`Conflict Recovery//`, so nothing inside is excluded and the plugin will rediscover its own
archived artifacts as fresh conflicts. Leading and repeated separators fail the same way.

Normalise the setting: strip leading and trailing separators, collapse repeats, then compare.
Add tests for trailing slash, leading slash, and doubled separators. Prefix siblings such as
`Conflict Recovery-old/` must still NOT be excluded — that case currently works, keep it.

## 6. The boundary tests overclaim

`src/boundaries.test.ts` greps source text, so it proves nobody wrote a literal spelling, not
that nothing deletes. All of these pass it:

```ts
const remove = app.vault.delete.bind(app.vault);  await remove(file);
await app.vault["delete"](file);
vault.delete?.(file);
```

It also false-positives on the strings inside comments.

Two things. Widen the patterns to catch bracket notation, optional call and `.bind(`. And
**change the test's own description** so it states what it actually verifies — a spelling
check, not a proof. Overclaiming in a safety test is worse than not having it, because it
stops people looking.

## 7. `VaultOps` has zero behavioural tests

Every test is either pure-core or a source grep. The one module that can touch a vault is
untested. Write behavioural tests against a fake adapter covering: the equality precondition
rejecting stale input; `moveToRecovery` picking a free path on collision; `restoreTo` aborting
on an occupied destination; a failing move on one copy not aborting the others.

A fake adapter cannot prove rename atomicity or real editor behaviour. Say so in a comment
rather than implying the coverage is stronger than it is.

---

## Rules unchanged

- Never call a deletion API. Not `vault.delete`, `vault.trash`, or `fileManager.trashFile`.
- `src/core/` never imports `obsidian`.
- Only `src/vault-ops.ts` mutates the vault.
- No `Co-Authored-By` or "Generated with" trailer on commits.
- Fix mechanical type and lint errors yourself; stop only for spec disagreements or
  environment failures.

## Done when

Seven commits, `npm test` green, `npm run build` and `npm run lint` exit 0, and the hunk-cap
test runs in well under a second. Do not push.
