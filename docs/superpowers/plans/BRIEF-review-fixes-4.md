# Brief: fourth review round — mostly subtraction

A fourth independent reviewer found that round three introduced a regression, the same as
rounds one and two. Three items here, and **the first is a revert**.

Read the note at the end first. It matters more than the individual fixes.

---

## 1. Revert the idempotent retry from `bb972d2`

`restoreTo` currently treats a pre-existing file with identical bytes as proof that its own
earlier `create` succeeded, and archives the conflict copy on that basis.

That proof does not exist. Byte equality cannot establish causality:

- A note someone else created with coincidentally identical content is accepted as our prior
  work, and the copy is archived away.
- File identity, inode, creation time and provenance are never established.
- There is a TOCTOU between reading the identical content and archiving.
- `restoreTo(copy, copy.path)` classifies the copy as its own retry and archives it.

It also contradicts the documented invariant that an occupied original aborts cleanly with the
copy untouched. Before this commit, every occupied destination aborted. After it, one specific
occupied destination silently proceeds.

**Revert to: any occupied destination throws `DestinationOccupied`, full stop.**

The state this was meant to handle — `create` succeeded, archival threw — is rare and
**non-destructive**: the original holds the restored content, the copy still exists, nothing
was lost. Report it clearly enough that a human can finish it by hand. Doing better needs
durable operation state, which is more machinery, and machinery is what has broken three
rounds running.

Delete the comment claiming "exact content equality makes the remaining archival step safely
retryable". It is the false claim that made this look sound.

Keep the surrounding structure from round three: the lookup that distinguishes a folder from a
file, and `create` remaining the sole no-clobber guard.

## 2. `..` is not stripped, and can escape the vault

`normalizeRecoveryFolder` removes `.` but leaves `..`:

```
"../Recovery"    -> "../Recovery"
"a/../../etc"    -> "a/../../etc"
"Conflicts/.."   -> "Conflicts/.."
```

Adapter paths are joined to the vault root, so on the desktop adapter `../Recovery` can resolve
**outside the vault**. It also breaks the exclusion, since the setting is then syntactically
unlike any real vault path.

Resolve `..` against preceding segments, and if the result would escape the root, reject it and
fall back to the default rather than silently clamping to something the user did not ask for.
Test `../Recovery`, `a/../b`, `a/../../etc`, `..`, and a value that reduces to nothing.

## 3. Two missing tests the reviewer named

- **Exactly 255 bytes.** Current tests cover 252 and 256, so a mutant rejecting `>= 255`
  instead of `> 255` passes. Add the boundary case.
- **Collision exhaustion.** No test covers buckets 2 through 999 all being unavailable. Add
  one asserting it throws rather than looping or silently overwriting.

---

## Why this brief is mostly a revert

Three rounds, three regressions, and every one came from **adding a mechanism**:

| round | fix | what it broke |
|---|---|---|
| 1 | `%00N` collision marker | filename byte length |
| 2 | collision subfolder | a regular file named `2` |
| 3 | idempotent retry | archives a coincidentally identical note |

Meanwhile every good decision in this project has been **subtraction**. Auto-clear was cut.
The five-step write-new-then-swap transaction was cut. Deletion was removed entirely. Pruning
was removed. The spec's best revision, rev 6, deleted more than it added.

When the available observations cannot support a guarantee, the answer is to stop trying to
provide it and say so, not to add a heuristic that is right most of the time. A heuristic that
is usually right is exactly what produces a rare, silent, hard-to-attribute failure.

If while doing these three you find yourself adding a mechanism to make something safe, stop
and describe it first. Prefer removing the requirement over satisfying it cleverly.

## Done when

Three commits, `npm test` green, build and lint clean, no claim in the spec or in a comment
that the implementation does not support. Do not push.
