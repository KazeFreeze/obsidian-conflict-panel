# Brief: third review round

A third independent reviewer checked round two. Four of six genuinely closed. Two problems,
one of which is **a test that asserts behaviour Obsidian does not have**, and one is a new
regression introduced by the collision-subfolder change.

That makes two consecutive rounds where the fix caused a regression. Before you start, read
the note at the end about why, because avoiding a third instance matters more than the
individual fixes.

Same rules: one commit each, update plan and spec snippets, fix mechanical errors yourself,
stop only for design decisions or environment failures.

---

## 1. The `normalizePath` mock invents behaviour that does not exist

`src/settings.test.ts` mocks `normalizePath` as filtering out `.` segments:

```ts
.filter((segment) => segment && segment !== ".")
```

Obsidian's actual declaration is `export function normalizePath(path: string): string;` with
**no documented behaviour at all**. It canonicalises separators, surrounding slashes,
whitespace and Unicode. It does **not** resolve dot segments.

So the test passes against a fiction while the real behaviour differs. `Archive/./Conflicts`
stays as-is, and because `group.ts` now trusts the setting verbatim, actual vault paths like
`Archive/Conflicts/x` will not match the exclusion root `Archive/./Conflicts/`, and recovery
artifacts get rediscovered as fresh conflicts. That is exactly the bug round one's finding 5
was meant to fix.

This is my error: I approved "normalise with Obsidian's `normalizePath`" without checking what
it guarantees.

**Fix both halves.** Do our own dot-segment and empty-segment removal rather than assuming
`normalizePath` does it, keeping `normalizePath` for the parts it genuinely handles. Then make
the mock reflect the real contract, not the one we wish existed. A mock that is more capable
than the real dependency is worse than no test.

Cover `Archive/./Conflicts`, `./Conflicts`, `Conflicts/.`, `a/./b/./c`, and the case where the
whole setting reduces to nothing and must fall back to the default.

## 2. A regular file named `2` blocks collision fallback

If the base archive exists and `Recovery/2` happens to be a **regular file**, `freePath` sees
`Recovery/2/<archive>` as absent and selects it. `ensureFolder` then sees `Recovery/2` "exists"
and assumes it is a folder. The rename fails rather than advancing to `Recovery/3`.

The old filename-marker scheme was immune to this, so it is a genuine regression from moving
the counter into the path.

**Fix:** existence is not enough, check the type. Use `adapter.stat()` and require a folder
before treating a path as a collision bucket, and advance to the next number when it is a
file. `ensureFolder` must do the same for every segment it creates, since the same confusion
applies to any parent.

## 3. `restoreTo` cannot distinguish why `create` failed

It propagates the raw error, so occupancy looks identical to permissions, an overlong
destination, or a missing parent. Callers cannot tell "someone recreated the note while you
were deciding" from "the write failed", and those need different messages in the UI.

Translate an occupancy failure into `DestinationOccupied` and leave other causes distinct.
Obsidian's error surface may not make this clean; if you cannot classify reliably, say so in a
comment and expose the raw cause rather than guessing.

## 4. Restore leaves a half-complete state with no path forward

If read and create succeed but archival throws, the original holds the restored content, the
copy remains, and the promise rejects. Retrying now fails because the original is occupied, so
the user is stuck with a failure message and a resurrection that already propagated.

Make the retry path work: if the original already holds exactly the content we were restoring,
treat archival as the only remaining step rather than starting over. Add a test.

## 5. Tests that still pass a broken implementation

Named by the reviewer:

- No test covers archival failing after a successful restore.
- `moveAllToRecovery` asserts statuses and vault state but never the returned `copy`, `error`
  or `recoveryPath` fields, so returning wrong ones passes.
- An older collision archive can be corrupted while the new copy still lands correctly; prior
  archive contents are populated but never re-asserted afterwards.

Same bar as before: each test must fail against a deliberately broken implementation.

---

## Why this keeps happening

Round one's `%00N` marker fixed ambiguity and broke filename length. Round two's collision
subfolder fixed length and broke on a file named `2`. Both times the fix was correct about the
thing it targeted and changed an assumption something else depended on.

Before you commit each fix, ask what the previous design was *implicitly* relying on that the
new one no longer provides. The filename marker relied on nothing outside the filename. The
subfolder scheme relies on a path component being a folder. That dependency is what needed a
test, and it is the kind of thing to look for rather than a thing to be told.

## Done when

Five commits, `npm test` green, build and lint clean, no mock more capable than the real
dependency, and no claim in the spec that the implementation does not support. Do not push.
