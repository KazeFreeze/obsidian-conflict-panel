# Brief: first UI review round

An independent reviewer with no knowledge of this plan's history went over
`7a9c301..88d77a4`. Verdict: **no**. Ten findings, and I verified the two biggest myself
rather than taking them on trust.

Both verifications held. One of them invalidates a claim the spec has carried through nine
revisions and five reviews.

Read section 6 before you start. It changes what the rest of the code is allowed to say.

---

## 1. The worst one: stale reviewed text stays actionable

`renderCopyPicker` sets `selectedCopy` synchronously and then awaits the read:

```ts
if (this.busy) return;
this.selectedCopy = i;
void this.loadSelection().then(() => this.render());
```

Press "Keep this copy" before that read lands and `busy` is still false, so `run()` proceeds.
`copyFile()` resolves to **B**, `this.reviewedCopy` still holds **A**, and `replaceOriginal`
writes A's text while the user believes they chose B.

`loadToken` does not prevent this. It only stops an older read publishing after a newer one.
Between the click and the read, the view holds a selection and a body that disagree.

**Fix by making the disagreement unrepresentable.** Null `reviewedOriginal`, `reviewedCopy`
and `diff` **synchronously**, in the picker handler, before any await. Then a `run()` that
arrives early finds `null` and cannot act. Refusing needs to be visible, so add a `loading`
flag, render the action bar disabled while it is set, and have `run()` say why if it is
somehow reached.

Do not fix this by making `dispatch` re-read the copy. That trades one race for another and
adds a read on every action.

## 2. `restore-copy` aborts the rest of the batch

`restoreTo` archives the selected copy itself. If that archival throws `RestoreArchiveFailed`,
the exception propagates out of `dispatch` and the remaining copies are never attempted. The
spec's rule is that one failure never aborts a batch, and `moveAllToRecovery` already honours
it everywhere else.

Catch `RestoreArchiveFailed` around `restoreTo`, keep going with the remaining copies, and fold
both outcomes into one notice. The restore itself succeeded, so the action still resolves.

## 3. Recovery restore corrupts binary artifacts

Every `.conflictbak` is read with `adapter.read` and rewritten with text `create`. Opaque
groups are deliberately archived, so images and PDFs are in that folder, and restoring one
produces a corrupt file. The archive survives, so nothing is lost, but the restored file is
garbage.

**Offer restore only when the decoded source path ends in `.md`.** Everything else gets the
same treatment an unsafe path gets: listed, explained, no button. Do not add a binary read
path for this. `createBinary` exists, but a second write path through `VaultOps` for a rare
manual recovery step is machinery this does not need.

## 4. Four deliberately broken implementations pass all 102 tests

The reviewer wrote each mutant and ran the suite. All four survived:

| mutant | why it survived |
|---|---|
| `scanConflicts` always returns `[]` | `scan.test.ts` only ever calls `buildVaultIndex` |
| `blockingPaths` ignores every copy, checking only `originalPath` | the sole test opens the original |
| `isSafeVaultPath` rejects any path containing `%` | no positive case has a literal percent |
| `createNew` writes `content.trim()` | the exact-content test uses `"new content"` |

Add the missing cases. Each must fail against its mutant: a `scanConflicts` test over a fake
vault, a `blockingPaths` case where only a **copy** is open, a `safe-path` case for
`50%25 done.md`, and a `createNew` case whose content begins and ends with whitespace and a
terminal newline.

## 5. Disappeared copies vanish silently

`allCopyFiles` filters out anything the vault no longer resolves. A copy Syncthing removed
between the scan and the action is neither moved nor mentioned, and the notice reports only
what it managed to move.

Compare against `group.copies.length` and say so when they differ. One sentence in the notice.

---

## 6. `vault.create` is not an atomic no-clobber primitive

I extracted `/usr/lib/obsidian/obsidian.asar` on this machine, Obsidian 1.13.7, and read
`Vault.prototype.create`:

```js
i = Nl(e); this.checkPath(i);
await this.adapter.exists(i);
if (exists) throw new Error("File already exists.");
await this.adapter.write(i, t, n);
```

`adapter.write` overwrites. So `create` is itself check-then-act, with an await between the
check and the write, and `adapter.rename` has exactly the same shape — it throws
`"Destination file already exists!"` after its own `_exists` call.

This matters because the spec says, in the section on the no-clobber rule, that `create` is
**the atomic no-clobber primitive**, and three review rounds removed a content-equality retry
on the strength of that. The retry deserved to go for its own reasons, but the argument that
replaced it was wrong.

**Do not build anything to close this.** The window is two adapter calls inside one process,
and the competing writer is Syncthing writing through the filesystem, which Obsidian's own
watcher races too. No plugin API can close it. What has to change is what we *claim*:

- Correct the spec. `create` is a **narrow-window guard**, not an atomic primitive. Say what
  the window is and why no plugin can close it.
- Correct every comment in `vault-ops.ts` calling `create` the sole *safety guard* or implying
  atomicity. It is the best available guard, which is a different sentence.
- Correct the UI plan, which asserts `adapter.rename` has **no** no-clobber guarantee. It has
  the same one `create` has. The reason recovery restore copies instead of renaming is now
  simply that leaving the archive in place is safer, not that rename was uniquely unguarded.

The conclusion the code reached is still right. The reasoning printed next to it is not.

## 7. Three claims to soften, no code change

- **Symlink escape.** `isSafeVaultPath` is lexical. A vault containing `link -> ../outside`
  lets `link/outside.md` pass and `create` follows the symlink. Say the guard rejects
  *encoded traversal*, not that it confines writes to the vault.
- **Editor guard.** It misses a Markdown file embedded as a card in Canvas, and it goes stale
  across the awaits inside `moveToRecovery` and `restoreTo`. It is a narrowing, and
  `editor-guard.ts` already says so; the commit message for `4f7f81c` does not.
- **Recovery restore has no editor guard, deliberately.** It only creates at a path that must
  be empty, so there is no open editor to lose. Add the comment saying why rather than adding
  a guard that protects nothing.

## 8. Two plan statements that are simply false

The self-review says every `VaultOps` entry point is reached through `run()`. Recovery restore
calls `createNew` directly. It also credits `loadToken` with preventing the pairing in finding
1, which it does not. Fix both sentences.

---

## 9. Measure the diff before keeping the confirmation

The soft band exists because the spec budgets 500ms for accepted worst-case input. The
reviewer measured a 24,500-character, 250-versus-250-line diff at about **24ms** on this
machine. If that holds, "Compare anyway" is a button guarding a fortieth of the cost it claims.

Measure where `toHunks` actually crosses ~200ms, with a committed benchmark, not a guess. Then:

- If the hard limit at 100,000 chars / 1,000 lines is already under that, **delete
  `needsConfirmation`, the flag, the button and `computeOnDemand` entirely.** The guard was
  written for a cost that does not exist.
- If it is not, move `SOFT_INPUT_*` to the measured crossing and record the measurement next
  to the constants.

Either outcome is fine. Keeping an unmeasured threshold is not.

---

## Why this brief is again mostly subtraction

Finding 3 removes a restore button. Finding 6 removes a claim. Finding 9 probably removes a
whole feature. The only genuine addition is one `loading` flag in finding 1, and it exists to
make a bad state impossible to represent rather than to detect it.

The core phase learned this over four rounds: when the observations cannot support a
guarantee, stop offering it. Finding 6 is that lesson arriving one level down, about a claim
we inherited from the API docs instead of measuring.

## Done when

`npm test` green with the four new cases failing against their mutants, build and lint clean,
no claim in the spec, a comment, a commit message or the plan that the code does not support.
Do not push.
