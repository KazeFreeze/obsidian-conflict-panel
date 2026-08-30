# Brief: implement Conflict Panel v0.1

You are implementing an Obsidian plugin. Everything you need is in this repo.

**Your plan:** `docs/superpowers/plans/2026-08-30-conflict-panel-v0.1.md`
**The spec it came from:** `docs/superpowers/specs/2026-08-30-conflict-panel-design.md`

Read the plan in full before touching anything. It has 6 tasks and 36 steps, and every
step contains the actual code — you should not have to invent implementations.

## How to work

Execute **task by task, in order**. Within a task, follow the steps exactly: write the
failing test, run it and confirm it fails, implement, run it and confirm it passes, commit.
The plan gives you the exact commands and the expected output for each run.

**Commit after every task**, using the message in the plan's commit step. Do not batch
tasks into one commit.

**Do not add a Co-Authored-By trailer or any "Generated with" line to commits.** The repo
owner publishes under his own name.

## Things the plan assumes you will not violate

These come from eight spec revisions and six adversarial audits. They are not style
preferences.

1. **Never call a deletion API.** Not `vault.delete`, not `vault.trash`, not
   `fileManager.trashFile`. Task 6 adds a test that greps every source file for these and
   fails the build if one appears. If you find yourself wanting to delete something, the
   answer is `vault.rename` into the recovery folder.
2. **`src/core/` must never import `obsidian`.** Same test enforces it. Core takes plain
   strings and returns plain data so it is unit-testable without the app.
3. **Only `src/vault-ops.ts` mutates the vault.** Same test enforces it.
4. **Use `adapter.exists()`, not `getAbstractFileByPath()`, when checking whether a
   recovery destination is free.** Unsupported extensions may not be loaded into Obsidian's
   vault tree, so the Vault API would report an existing file as absent and you would
   rename over it.

## If you get stuck

Do not guess at design decisions. The spec is the authority; if the spec and the plan
disagree, stop and say so rather than picking one.

Announce a block so the orchestrator sees it with a reason attached:

```bash
/home/bernardjr/.claude/skills/orchestrating-herdr-agents/scripts/herdr-say.sh \
  --state blocked --task conflict-panel-v0.1 --why "<one line: what you need>"
```

## Definition of done

All 6 tasks complete, `npm test` green, `npm run build` exits 0, `npm run lint` exits 0,
and six commits on `main`. Do not push; the orchestrator will review first.

Report at the end: which tasks completed, the test count, and anything in the plan that
turned out to be wrong.
