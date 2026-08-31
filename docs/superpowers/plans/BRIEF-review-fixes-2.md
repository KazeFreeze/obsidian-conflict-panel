# Brief: second review round

A second independent reviewer checked your seven fixes. Four landed, three are partial, and
**one of my approvals caused a regression.** Ordered by what to fix first.

Same rules as before: commit each separately, update the plan and spec snippets so they stop
carrying the bug, fix mechanical errors yourself, stop only for design decisions or
environment failures.

---

## 1. `restoreTo` is not fixed, and cannot be fixed by checking harder

Adding a second `adapter.exists()` before `vault.rename()` resamples the race, it does not
close it. The interval between the final check and the rename is still unbounded, and
`Vault.rename` has no no-clobber guarantee. The spec calls this rule **mandatory**, so
documenting it is not enough.

**Use an operation that fails on an occupied destination instead of checking first.**
`Vault.create(path, data)` throws when the path exists, which is an atomic no-clobber
primitive the API actually gives you. Restore becomes: create the original path with the
copy's content, and only if that succeeds, archive the copy.

If the create fails, nothing happened. If the archive fails afterwards, you have a duplicate
rather than an overwrite. That is the ordering the whole design is built on: never let the
failure mode be loss.

`freePath` → recovery rename has the same race. The current comment claims a collision there
"costs a duplicate artifact, not data", and the reviewer is right that this is unsupported: a
clobbered `.conflictbak` is a previously archived losing version, which is data. Either make
that destination no-clobber too, or correct the comment to say what can actually be lost.

## 2. The `%00N` marker caused a filename-length regression

I approved it for unambiguity and never considered length. It is two bytes longer than `-N`,
which pushes archives over the 255-byte component limit that previously fit:

```
source  "a/" × 58 + "xnote.md"        124 bytes
flattened, no collision               252 bytes   OK
old marker  -2                        254 bytes   OK
new marker  %002                      256 bytes   ENAMETOOLONG
```

Verified. Your unambiguity reasoning was sound; the length was my oversight in approving it.

**Put the collision counter in the path, not the filename.** Something like
`Conflict Recovery/2/<encoded>.conflictbak` keeps the basename a constant size no matter how
many collisions occur, and it stays trivially decodable. Propose an alternative if you see a
better one.

Separately, **nothing currently checks length at all.** A deeply nested source path can exceed
the limit with no collision involved, and UTF-8 multi-byte characters reach it sooner than
`String.length` suggests. Measure `Buffer.byteLength`-equivalent, not string length, and fail
with a clear error rather than an adapter exception.

## 3. `toHunks` yields once, then blocks

`await setTimeout(0)` before the work starts is not cooperative. `diffLines` then monopolises
the thread to completion. Measured: **176–179ms for accepted 1,000-line input**, which is a
visible freeze on desktop and worse in a mobile WebView.

Either chunk the diff so it yields periodically, or accept that it is bounded-but-blocking and
**say so plainly** in the code, the spec, and the test name. The spec currently claims
"bounded and yielding" and only the first half is true. Do not leave a claim standing that the
implementation does not support.

The thresholds (100,000 chars, 1,000 lines) are reasonable shapes but arbitrary values. At
minimum add a test asserting the *accepted worst case* completes within a stated budget, so a
future change that makes it slower fails visibly.

## 4. Three different path normalisations

`ensureFolder` strips empty segments, `groupConflicts` collapses slashes and trims edges, and
`recoveryPathFor` uses the raw setting. With a leading or repeated separator, the folder
created, the rename target, and the exclusion root can be three different strings.

**Normalise once at the settings boundary** and pass the normalised value everywhere. Use
Obsidian's own path normaliser rather than hand-rolling a third variant.

That also fixes the remaining exclusion bypass: `Archive/./Conflicts` normalises to
`Archive/Conflicts` in vault enumeration but is compared as `Archive/./Conflicts/`, so the
plugin rediscovers its own archives. `Archive\Conflicts` fails the same way where backslashes
are canonicalised.

## 5. Off-by-one rejects exactly 1,000 lines

1,000 newline-terminated lines count as 1,001 and are rejected, even though the hunk
conversion drops the trailing empty element. Count the way `lines()` counts.

## 6. Several `VaultOps` tests pass broken implementations

Named by the reviewer, all real:

- Both restore tests pass an implementation that performs the checks then **always throws**.
  There is no successful free-destination test.
- The stale-input test passes an implementation that **never calls `vault.process`** and just
  throws `StaleInput`.
- The batch test passes an implementation that renames to a **wrong target**, catches, and
  fabricates the same statuses. It never asserts destination paths.
- The nested-folder test passes if the `mkdir` calls occur even when rename goes somewhere
  wrong entirely.

Assert the observable outcome — which path ended up where — not merely that a mock was called.
A test that passes against a deliberately broken implementation is worse than no test, because
it stops anyone looking.

---

## Done when

Six commits, `npm test` green, build and lint clean, and every claim in the spec matched by the
implementation. Where something genuinely cannot be guaranteed with the public API, say so in
the spec rather than implying it is handled. Do not push.
