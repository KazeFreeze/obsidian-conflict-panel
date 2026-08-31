# Conflict Panel — UI phase implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the finished decision core to an interface, producing the first version of this plugin that can actually resolve a conflict.

**Architecture:** Three Obsidian surfaces over the existing pure core. A sidebar `ItemView` lists groups with a count, a main-tab `ItemView` shows the diff and actions, and a Recovery list reads archived artifacts through `DataAdapter`. All decision logic already exists in `src/core/`; these views only render it and call `VaultOps`.

**Tech Stack:** TypeScript, esbuild, vitest, Obsidian API 1.13.x.

**Spec:** `docs/superpowers/specs/2026-08-30-conflict-panel-design.md` (rev 8).
**Core phase:** `docs/superpowers/plans/2026-08-30-conflict-panel-core.md`, complete at `bf66329`.

---

## What already exists

Do not reimplement any of this. Read it before starting.

```ts
// src/core/group.ts
groupConflicts(paths: string[], index: VaultIndex, recoveryFolder: string): ConflictGroup[]
interface VaultIndex { files: Set<string>; folders: Set<string> }

// src/core/entry-view.ts — actions derive from SHAPE, unknown shapes are view-only
describeGroup(group: ConflictGroup): EntryView
type EntryAction = "keep-original" | "keep-copy" | "save-as-new" | "restore-copy" | "accept-deletion"
interface EntryView { actions: EntryAction[]; diffable: boolean; warning: string | null; explanation: string | null }

// src/core/diff.ts — SYNCHRONOUS and BLOCKING, see the constraint below
toHunks(left: string, right: string, maxHunks?: number): DiffResult
type DiffResult = { status: "ok"; hunks: Hunk[] } | { status: "too-large" }

// src/vault-ops.ts — the ONLY module permitted to mutate the vault
replaceOriginal(original: TFile, reviewedText: string, chosenText: string): Promise<void>
moveToRecovery(copy: TFile): Promise<string>
moveAllToRecovery(copies: TFile[]): Promise<RecoveryMoveResult[]>
restoreTo(copy: TFile, originalPath: string): Promise<void>
// throws: StaleInput | DestinationOccupied | ArchiveNameTooLong | RestoreArchiveFailed
```

## Constraints this phase inherits

**`toHunks` blocks.** It is bounded but not cooperative: input it accepts, right up to
100,000 chars / 1,000 lines, costs up to a 500ms budget of synchronous work. Two rules follow,
and the first draft of this plan broke both.

1. **Never call it during a render pass or an event handler that must stay responsive.**
   Compute once when a group is loaded and render from the stored `DiffResult`.
2. The spec requires **an additional UI guard for accepted-but-large input**. Task 3 adds it:
   a soft band below which the diff computes on its own, and above which the user presses a
   button, so the one blocking call is deliberate and attributable.

**The editor guard is this phase's job.** The core has no idea whether a file is open.
Nothing may call `VaultOps` while any file in the group is open in an editor, because a
pending editor autosave can overwrite the result. That guard does not exist yet.

**Only `src/vault-ops.ts` may mutate the vault.** `src/boundaries.test.ts` greps every source
file for `vault.process|rename|create|modify` and fails on a match outside that one file. A
view that calls `vault.create` directly turns the suite red. Every write this phase needs goes
through `VaultOps`, which is why Task 4 exists.

**No check-then-act anywhere.** `create` throwing on an occupied path is the sole no-clobber
guard. An `exists()` lookup may only *reject*; it may never authorise a write. This was removed
from core restore across three review rounds and must not come back in a view.

**A recovery artifact's decoded path is untrusted input.** `sourcePathFromRecovery` turns
`%2F` back into `/`, so an artifact named `..%2Foutside.md.conflictbak` — a perfectly ordinary
filename that Syncthing will happily deliver — decodes to `../outside.md`. Round four
established that `..` escapes the vault through adapter-backed paths. Every decoded path is
validated before it reaches a write, and an artifact that fails is listed without a restore
button rather than silently rewritten.

**The recovery folder can change while a view is open.** `saveSettings()` can move it at any
time, so a `VaultOps` captured once in `onload` goes stale and would archive into the old
folder while scans exclude the new one. Views receive an accessor, never a snapshot.

**Every control needs a visible text label** and a ≥48dp touch target. Two buttons
distinguished only by a tooltip is the exact defect that made an audited plugin unusable on
Android.

**Decisions must not live only in the DOM.** Android can destroy and rebuild a view at any
`await`.

---

## File Structure

| file | responsibility |
|---|---|
| `src/core/diff.ts` | *Modified.* Add `needsConfirmation`, the soft band above which the diff is user-initiated. |
| `src/core/safe-path.ts` | `isSafeVaultPath`, the reject-don't-sanitise guard for decoded artifact paths. |
| `src/vault-ops.ts` | *Modified.* Add `createNew`, the only write path the views get. |
| `src/scan.ts` | Build `VaultIndex` from the vault, call `groupConflicts`, cache the result. |
| `src/editor-guard.ts` | Answer "is any file in this group open in an editor?" Testable with a fake workspace. |
| `src/panel-view.ts` | Sidebar `ItemView`: the group list and count. |
| `src/compare-view.ts` | Main-tab `ItemView`: diff and actions. Calls `VaultOps`, never the vault. |
| `src/recovery-view.ts` | Recovery list over `DataAdapter`, restoring through `VaultOps.createNew`. |
| `src/main.ts` | Registers views, commands, ribbon; owns the scan cache and the `VaultOps` instance. |

---

### Task 1: `src/scan.ts`

**Files:**
- Create: `src/scan.ts`, `src/scan.test.ts`

- [ ] **Step 1: Write the failing test `src/scan.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";

const { MockTFile, MockTFolder } = vi.hoisted(() => ({
	MockTFile: class { constructor(readonly path: string) {} },
	MockTFolder: class { constructor(readonly path: string) {} },
}));
vi.mock("obsidian", () => ({ TFile: MockTFile, TFolder: MockTFolder }));

import { buildVaultIndex } from "./scan";

describe("buildVaultIndex", () => {
	it("separates files from folders", () => {
		const vault = {
			getAllLoadedFiles: () => [new MockTFile("note.md"), new MockTFolder("folder")],
		};
		const index = buildVaultIndex(vault as never);
		expect(index.files.has("note.md")).toBe(true);
		expect(index.folders.has("folder")).toBe(true);
		expect(index.files.has("folder")).toBe(false);
	});

	it("returns empty sets for an empty vault", () => {
		const index = buildVaultIndex({ getAllLoadedFiles: () => [] } as never);
		expect(index.files.size).toBe(0);
		expect(index.folders.size).toBe(0);
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- scan`
Expected: FAIL, `Failed to resolve import "./scan"`.

- [ ] **Step 3: Implement `src/scan.ts`**

```ts
import { TFile, TFolder, type Vault } from "obsidian";
import { groupConflicts } from "./core/group";
import type { ConflictGroup } from "./core/types";

/**
 * Build the index `groupConflicts` needs.
 *
 * Uses `getAllLoadedFiles` rather than `getFiles` because the grouper must know
 * about FOLDERS too: a folder occupying a canonical path is its own shape, and
 * `getFiles` would report that path as simply absent.
 */
export function buildVaultIndex(vault: Vault): { files: Set<string>; folders: Set<string> } {
	const files = new Set<string>();
	const folders = new Set<string>();
	for (const entry of vault.getAllLoadedFiles()) {
		if (entry instanceof TFolder) folders.add(entry.path);
		else if (entry instanceof TFile) files.add(entry.path);
	}
	return { files, folders };
}

export function scanConflicts(vault: Vault, recoveryFolder: string): ConflictGroup[] {
	const index = buildVaultIndex(vault);
	return groupConflicts([...index.files], index, recoveryFolder);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- scan`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/scan.ts src/scan.test.ts
git commit -m "feat: build the vault index and scan for conflict groups"
```

---

### Task 2: `src/editor-guard.ts`

The guard the spec requires and the core cannot provide.

**Files:**
- Create: `src/editor-guard.ts`, `src/editor-guard.test.ts`

- [ ] **Step 1: Write the failing test `src/editor-guard.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { openPathsIn } from "./editor-guard";

/** Fake workspace: iterateAllLeaves visits every leaf, including sidebars and pop-outs. */
const workspace = (paths: (string | null)[]) => ({
	iterateAllLeaves(cb: (leaf: { view: { file?: { path: string } } }) => void) {
		for (const p of paths) cb({ view: p ? { file: { path: p } } : {} });
	},
});

describe("openPathsIn", () => {
	it("returns the paths of files open in any leaf", () => {
		const open = openPathsIn(workspace(["a.md", "b.md"]) as never);
		expect(open).toEqual(new Set(["a.md", "b.md"]));
	});

	it("ignores leaves with no file", () => {
		expect(openPathsIn(workspace([null]) as never).size).toBe(0);
	});

	it("returns an empty set when nothing is open", () => {
		expect(openPathsIn(workspace([]) as never).size).toBe(0);
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- editor-guard`
Expected: FAIL, `Failed to resolve import "./editor-guard"`.

- [ ] **Step 3: Implement `src/editor-guard.ts`**

```ts
import type { Workspace } from "obsidian";
import type { ConflictGroup } from "./core/types";

/**
 * Every path currently open in a leaf.
 *
 * `iterateAllLeaves` covers sidebar and pop-out leaves, which `activeEditor` does
 * not. This cannot see editors embedded by other plugins, and cannot stop a note
 * being opened during an awaited operation — a narrowing, not a guarantee.
 */
export function openPathsIn(workspace: Workspace): Set<string> {
	const open = new Set<string>();
	workspace.iterateAllLeaves((leaf) => {
		const file = (leaf.view as { file?: { path: string } }).file;
		if (file?.path) open.add(file.path);
	});
	return open;
}

/** Which files of this group are open, if any. Empty means safe to proceed. */
export function blockingPaths(group: ConflictGroup, open: Set<string>): string[] {
	const candidates = [group.originalPath, ...group.copies.map((c) => c.path)];
	return candidates.filter((p) => open.has(p));
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- editor-guard`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add a `blockingPaths` test and commit**

```ts
it("reports which of a group's files are open", () => {
	const group = {
		originalPath: "note.md",
		shape: "normal" as const,
		copies: [{ path: "note.sync-conflict-20260830-143000-AAA.md" } as never],
	};
	expect(blockingPaths(group as never, new Set(["note.md"]))).toEqual(["note.md"]);
	expect(blockingPaths(group as never, new Set())).toEqual([]);
});
```

Run: `npm test -- editor-guard`
Expected: PASS, 4 tests.

```bash
git add src/editor-guard.ts src/editor-guard.test.ts
git commit -m "feat: refuse to resolve while a group file is open in an editor"
```

---

### Task 3: `needsConfirmation` in `src/core/diff.ts`

The UI guard the spec asks for, kept in `core/` because it is a pure predicate and belongs
next to the thresholds it shadows.

**Files:**
- Modify: `src/core/diff.ts`, `src/core/diff.test.ts`

- [ ] **Step 1: Add the failing tests to `src/core/diff.test.ts`**

```ts
import { needsConfirmation } from "./diff";

describe("needsConfirmation", () => {
	it("lets small input compare without asking", () => {
		expect(needsConfirmation("a\nb", "a\nc")).toBe(false);
	});

	it("asks before comparing input past the soft character band", () => {
		expect(needsConfirmation("x".repeat(25_001), "y")).toBe(true);
	});

	it("asks before comparing input past the soft line band", () => {
		expect(needsConfirmation("x\n".repeat(251), "y")).toBe(true);
	});

	it("asks for 251 lines without a terminating newline", () => {
		expect(needsConfirmation(Array.from({ length: 251 }, () => "x").join("\n"), "y")).toBe(true);
	});

	it("asks when only the right side is large", () => {
		expect(needsConfirmation("y", "x".repeat(25_001))).toBe(true);
	});

	it("does not ask exactly at the band", () => {
		expect(needsConfirmation("x".repeat(25_000), "y")).toBe(false);
	});
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npm test -- diff`
Expected: FAIL, `needsConfirmation is not a function`.

- [ ] **Step 3: Implement it**

```ts
// A quarter of the hard limit. Below this the diff is cheap enough to run
// unannounced; above it the 500ms freeze is noticeable, so the user asks for it
// and can attribute the pause. toHunks still rejects anything past MAX_INPUT_*.
const SOFT_INPUT_CHARS = 25_000;
const SOFT_INPUT_LINES = 250;

const pastSoftBand = (value: string): boolean => {
	if (value.length > SOFT_INPUT_CHARS) return true;
	// Match toHunks: a trailing newline does not create a displayed empty line.
	let lineCount = value.length === 0 ? 0 : 1;
	for (let i = 0; i < value.length - 1; i++) {
		if (value.charCodeAt(i) === 10 && ++lineCount > SOFT_INPUT_LINES) return true;
	}
	return false;
};

/**
 * Should the view make the user press a button before diffing?
 *
 * toHunks is synchronous and uncooperative. It refuses genuinely huge input, but
 * everything it ACCEPTS still blocks the main thread for up to 500ms. This is the
 * guard for that accepted-but-large band.
 */
export function needsConfirmation(left: string, right: string): boolean {
	return pastSoftBand(left) || pastSoftBand(right);
}
```

- [ ] **Step 4: Run and confirm they pass**

Run: `npm test -- diff`
Expected: PASS, existing tests plus 5.

- [ ] **Step 5: Commit**

```bash
git add src/core/diff.ts src/core/diff.test.ts
git commit -m "feat: make an expensive diff user-initiated rather than automatic"
```

---

### Task 4: the guarded write path

Both remaining writes in this phase — save-as-new, and copying a recovery artifact back — are
"create a file at a path that must be empty". That is what `restoreTo` already does internally.
Expose it once rather than letting two views reach for `vault.create` and turn
`boundaries.test.ts` red.

One of those two paths comes from a **filename on disk**, so it also needs validating. Both
halves live in this task because they are one concern: the single chokepoint through which a
view may write.

**Files:**
- Create: `src/core/safe-path.ts`, `src/core/safe-path.test.ts`
- Modify: `src/vault-ops.ts`, `src/vault-ops.test.ts`

- [ ] **Step 1: Write the failing test `src/core/safe-path.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { isSafeVaultPath } from "./safe-path";

describe("isSafeVaultPath", () => {
	it.each(["note.md", "a/b/note.md", "Folder Name/note with spaces.md"])(
		"accepts the ordinary vault path %j",
		(path) => expect(isSafeVaultPath(path)).toBe(true),
	);

	it.each([
		"../outside.md",          // the decoded-artifact attack
		"a/../../outside.md",
		"..",
		"/absolute.md",
		"a//b.md",                // an empty segment
		"a/./b.md",               // harmless but not a path we produced
		"..\\outside.md",         // backslash is not canonical and traverses on Windows
		"\\absolute.md",
		"",
	])("rejects %j", (path) => expect(isSafeVaultPath(path)).toBe(false));
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- safe-path`
Expected: FAIL, cannot resolve `./safe-path`.

- [ ] **Step 3: Implement `src/core/safe-path.ts`**

```ts
/**
 * Is this a path we are willing to write to?
 *
 * REJECTS rather than sanitises, deliberately. `normalizeRecoveryFolder` cleans up a
 * setting the user typed, where a silent correction is helpful. This is different:
 * the input is a FILENAME ON DISK, decoded by `sourcePathFromRecovery`, and
 * `..%2Foutside.md.conflictbak` decodes to `../outside.md`. Silently rewriting that
 * to somewhere else would write a file the user never asked for, at a path they
 * cannot predict. Refusing is the only honest answer.
 */
export function isSafeVaultPath(path: string): boolean {
	if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
	return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- safe-path`
Expected: PASS, 10 cases.

- [ ] **Step 5: Commit the guard**

```bash
git add src/core/safe-path.ts src/core/safe-path.test.ts
git commit -m "feat: reject a decoded artifact path that would escape the vault"
```

- [ ] **Step 6: Write the failing tests for `createNew`**

Add to `src/vault-ops.test.ts`:

```ts
describe("createNew", () => {
	it("writes the content at an empty path", async () => { /* assert exact content */ });

	it("throws DestinationOccupied when a file already holds the path", async () => {
		await expect(ops.createNew("note.md", "x")).rejects.toBeInstanceOf(DestinationOccupied);
	});

	it("throws DestinationOccupied when a FOLDER holds the path", async () => { /* ... */ });

	it("leaves the existing file byte-identical when it refuses", async () => { /* ... */ });

	it("throws UnsafePath before touching the vault for ../outside.md", async () => {
		await expect(ops.createNew("../outside.md", "x")).rejects.toBeInstanceOf(UnsafePath);
	});

	it("writes nothing anywhere when the path is unsafe", async () => {
		/* assert the whole in-memory model is unchanged, not just the target */
	});
});
```

The fourth and sixth are the ones that must fail against a broken implementation: a `createNew`
that overwrites passes the first three, and one that validates *after* writing passes the fifth.

- [ ] **Step 7: Run and confirm they fail**

Run: `npm test -- vault-ops`

- [ ] **Step 8: Implement `createNew`**

Import the pure guard at the top of `src/vault-ops.ts`:

```ts
import { isSafeVaultPath } from "./core/safe-path";
```

```ts
export class UnsafePath extends Error {
	constructor(readonly path: string) {
		super(`${path} is not a path inside this vault. Nothing was written.`);
	}
}
```

```ts
	/**
	 * Create a file at a path that must be empty.
	 *
	 * The lookup only RECOGNISES an occupied path. It never authorises the write:
	 * `create` remains the sole no-clobber guard, exactly as in `restoreTo`. Do not
	 * turn this into a check-then-act by acting on what the lookup returns.
	 *
	 * The safety check comes FIRST, before any vault call, because one caller passes
	 * a path decoded from a filename on disk.
	 */
	async createNew(path: string, content: string): Promise<void> {
		if (!isSafeVaultPath(path)) throw new UnsafePath(path);
		if (this.app.vault.getAbstractFileByPath(path)) throw new DestinationOccupied(path);
		await this.app.vault.create(path, content);
	}
```

- [ ] **Step 9: Run and confirm they pass**

Run: `npm test`
Expected: all green, `boundaries` included.

- [ ] **Step 10: Commit**

```bash
git add src/vault-ops.ts src/vault-ops.test.ts
git commit -m "feat: give the views one guarded create instead of raw vault access"
```

---

### Task 5: `src/panel-view.ts`

**Files:**
- Create: `src/panel-view.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Implement `src/panel-view.ts`**

```ts
import { ItemView, WorkspaceLeaf } from "obsidian";
import { describeGroup } from "./core/entry-view";
import type { ConflictGroup } from "./core/types";

export const CONFLICT_PANEL_VIEW = "conflict-panel-list";

export class ConflictPanelView extends ItemView {
	private groups: ConflictGroup[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private readonly onOpenGroup: (group: ConflictGroup) => void,
		private readonly onRescan: () => Promise<void>,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CONFLICT_PANEL_VIEW;
	}

	getDisplayText(): string {
		return "Conflicts";
	}

	getIcon(): string {
		return "git-merge";
	}

	setGroups(groups: ConflictGroup[]): void {
		this.groups = groups;
		this.render();
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("conflict-panel");

		const header = root.createDiv({ cls: "conflict-panel__header" });
		header.createEl("h4", {
			text: this.groups.length === 1 ? "1 conflict" : `${this.groups.length} conflicts`,
		});
		// A visible text label, not an icon: this must be usable on a touch screen.
		header
			.createEl("button", { text: "Rescan", cls: "conflict-panel__rescan" })
			.addEventListener("click", () => void this.onRescan());

		if (this.groups.length === 0) {
			root.createEl("p", {
				text: "No conflict files found.",
				cls: "conflict-panel__empty",
			});
			return;
		}

		const list = root.createEl("ul", { cls: "conflict-panel__list" });
		for (const group of this.groups) {
			const view = describeGroup(group);
			const item = list.createEl("li", { cls: "conflict-panel__item" });
			const button = item.createEl("button", { cls: "conflict-panel__entry" });
			button.createSpan({ text: group.originalPath, cls: "conflict-panel__path" });
			button.createSpan({
				text: group.copies.length === 1 ? "1 copy" : `${group.copies.length} copies`,
				cls: "conflict-panel__meta",
			});
			if (view.explanation) {
				button.createSpan({ text: view.explanation, cls: "conflict-panel__note" });
			}
			button.addEventListener("click", () => this.onOpenGroup(group));
		}
	}
}
```

- [ ] **Step 2: Register it in `src/main.ts`**

Inside `onload()`, after `loadSettings()`:

```ts
this.registerView(
	CONFLICT_PANEL_VIEW,
	(leaf) =>
		new ConflictPanelView(
			leaf,
			(group) => void this.openCompareView(group),
			() => this.rescan(),
		),
);

this.addRibbonIcon("git-merge", "Show conflicts", () => void this.revealPanel());

this.addCommand({
	id: "scan-conflicts",
	name: "Scan for sync conflicts",
	callback: () => void this.rescan(),
});
```

Add the supporting methods:

```ts
async rescan(): Promise<void> {
	this.groups = scanConflicts(this.app.vault, this.settings.recoveryFolder);
	for (const leaf of this.app.workspace.getLeavesOfType(CONFLICT_PANEL_VIEW)) {
		(leaf.view as ConflictPanelView).setGroups(this.groups);
	}
}

async revealPanel(): Promise<void> {
	const existing = this.app.workspace.getLeavesOfType(CONFLICT_PANEL_VIEW);
	if (existing.length > 0) {
		this.app.workspace.setActiveLeaf(existing[0], { focus: true });
		return;
	}
	const leaf = this.app.workspace.getRightLeaf(false);
	if (!leaf) return;
	await leaf.setViewState({ type: CONFLICT_PANEL_VIEW, active: true });
	await this.rescan();
}
```

Use `setActiveLeaf`, not `revealLeaf`: the latter requires Obsidian 1.7.2 while this plugin's
existing `minAppVersion` is 1.1.0. The existing compatibility contract wins.

Task 5 must build before Task 6 creates `ConflictCompareView`. Add this temporary staging method,
then replace its body in Task 6:

```ts
async openCompareView(group: ConflictGroup): Promise<void> {
	void group;
}
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build && npm run lint`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/panel-view.ts src/main.ts
git commit -m "feat: sidebar panel listing conflict groups with a count"
```

---

### Task 6: `src/compare-view.ts`

The only surface that calls `VaultOps`. Every action goes through the editor guard first.
**No vault mutation call appears in this file** — reads and lookups use `vault.*`, while
`boundaries.test.ts` enforces that every mutation goes through `VaultOps`.

**Files:**
- Create: `src/compare-view.ts`
- Modify: `src/main.ts`, `styles.css`

- [ ] **Step 1: The view shell, with the diff computed OUTSIDE render**

```ts
import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { needsConfirmation, toHunks, type DiffResult } from "./core/diff";
import { describeGroup, type EntryAction } from "./core/entry-view";
import type { ConflictGroup } from "./core/types";
import { blockingPaths, openPathsIn } from "./editor-guard";
import {
	DestinationOccupied,
	RestoreArchiveFailed,
	StaleInput,
	UnsafePath,
	VaultOps,
} from "./vault-ops";

export const CONFLICT_COMPARE_VIEW = "conflict-panel-compare";

export class ConflictCompareView extends ItemView {
	private group: ConflictGroup | null = null;
	private selectedCopy = 0;
	/** Held OUTSIDE the DOM: Android can destroy and rebuild a view at any await. */
	private reviewedOriginal: string | null = null;
	private reviewedCopy: string | null = null;
	/** null means "not computed yet", which is distinct from an empty hunk list. */
	private diff: DiffResult | null = null;
	private awaitingConfirmation = false;
	private busy = false;
	/** Bumped on every selection change so a slow read cannot land after a fast one. */
	private loadToken = 0;

	constructor(
		leaf: WorkspaceLeaf,
		// An ACCESSOR, not the instance. saveSettings() can move the recovery folder
		// while this view is open, and a captured VaultOps would archive into the old
		// one while scans exclude the new one.
		private readonly ops: () => VaultOps,
		private readonly afterResolve: () => Promise<void>,
	) {
		super(leaf);
	}

	getViewType(): string { return CONFLICT_COMPARE_VIEW; }
	getDisplayText(): string { return this.group ? `Conflict: ${this.group.originalPath}` : "Conflict"; }
	getIcon(): string { return "git-compare"; }

	async setGroup(group: ConflictGroup): Promise<void> {
		this.group = group;
		this.selectedCopy = 0;
		await this.loadSelection();
		this.render();
	}

	/**
	 * Read both sides and decide about the diff ONCE.
	 *
	 * toHunks is bounded but BLOCKING, so it must never run inside render(). Past
	 * the soft band it does not run here either: the view shows a button, and the
	 * event-handler freeze becomes something the user explicitly asked for.
	 */
	private async loadSelection(): Promise<void> {
		// Tapping through copies starts overlapping reads. Without this token an older
		// read can finish LAST, leaving selectedCopy on B while reviewedCopy holds A —
		// and "Keep this copy" would then write the wrong content. Nothing is assigned
		// to a field until the token proves this read is still the current one.
		const token = ++this.loadToken;
		const copy = this.copyFile();
		const original = this.originalFile();
		const copyText = copy ? await this.app.vault.read(copy) : null;
		const originalText = original ? await this.app.vault.read(original) : null;
		if (token !== this.loadToken) return;

		this.reviewedCopy = copyText;
		this.reviewedOriginal = originalText;
		this.diff = null;
		this.awaitingConfirmation = false;

		if (originalText === null || copyText === null) return;
		if (needsConfirmation(originalText, copyText)) this.awaitingConfirmation = true;
		else this.diff = toHunks(originalText, copyText);
	}

	/** The one deliberate blocking call, reached only by pressing the button. */
	private computeOnDemand(): void {
		const left = this.reviewedOriginal;
		const right = this.reviewedCopy;
		if (left === null || right === null) return;
		this.awaitingConfirmation = false;
		this.diff = toHunks(left, right);
		this.render();
	}

	private originalFile(): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.group?.originalPath ?? "");
		return f instanceof TFile ? f : null;
	}

	private copyFile(): TFile | null {
		const path = this.group?.copies[this.selectedCopy]?.path;
		if (!path) return null;
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}
}
```

- [ ] **Step 2: Render, reading only stored state**

```ts
	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("conflict-compare");

		const group = this.group;
		if (!group) return;
		const view = describeGroup(group);

		root.createEl("h3", { text: group.originalPath });
		if (view.explanation) root.createEl("p", { text: view.explanation, cls: "conflict-compare__explanation" });
		if (view.warning) root.createEl("p", { text: view.warning, cls: "conflict-compare__warning" });

		this.renderCopyPicker(root, group);
		if (view.diffable) this.renderDiff(root);
		this.renderActions(root, view.actions);
	}

	private renderCopyPicker(root: HTMLElement, group: ConflictGroup): void {
		if (group.copies.length < 2) return;
		const picker = root.createDiv({ cls: "conflict-compare__copies" });
		group.copies.forEach((copy, i) => {
			const label = `device ${copy.deviceId}, ${copy.time.slice(0, 2)}:${copy.time.slice(2, 4)}`;
			const button = picker.createEl("button", { text: label });
			if (i === this.selectedCopy) button.addClass("is-selected");
			button.addEventListener("click", () => {
				if (this.busy) return; // a write is in flight against the current selection
				this.selectedCopy = i;
				void this.loadSelection().then(() => this.render());
			});
		});
	}

	/** Renders STORED state. Never computes: see loadSelection. */
	private renderDiff(root: HTMLElement): void {
		const box = root.createDiv({ cls: "conflict-compare__diff" });

		if (this.awaitingConfirmation) {
			box.createEl("p", {
				text: "These files are large. Comparing them will freeze Obsidian for up to half a second.",
			});
			box
				.createEl("button", { text: "Compare anyway" })
				.addEventListener("click", () => this.computeOnDemand());
			return;
		}

		const result = this.diff;
		if (result === null) return;
		if (result.status === "too-large") {
			box.createEl("p", { text: "These files are too large to compare here. Open them side by side instead." });
			return;
		}
		if (result.hunks.length === 0) {
			box.createEl("p", { text: "The two files have identical text." });
			return;
		}
		for (const hunk of result.hunks) {
			const el = box.createDiv({ cls: "conflict-compare__hunk" });
			for (const line of hunk.left) el.createDiv({ text: line, cls: "conflict-compare__line is-left" });
			for (const line of hunk.right) el.createDiv({ text: line, cls: "conflict-compare__line is-right" });
		}
	}
```

- [ ] **Step 3: Actions, each gated, each matching the spec's action matrix**

The matrix in the spec is authoritative. **`keep-copy` and `restore-copy` move ALL copies to
recovery, not just the selected one** — the user picks one *X* to keep, and every other copy is
preserved in recovery rather than left behind to be rediscovered.

```ts
	private renderActions(root: HTMLElement, actions: readonly EntryAction[]): void {
		if (actions.length === 0) return;
		const bar = root.createDiv({ cls: "conflict-compare__actions" });
		const label: Record<EntryAction, string> = {
			"keep-original": "Keep the original",
			"keep-copy": "Keep this copy",
			"save-as-new": "Save this copy as a new note",
			"restore-copy": "Restore this copy",
			"accept-deletion": "Move copies to recovery",
		};
		for (const action of actions) {
			// Visible text, never an icon or a tooltip alone: this must work on touch.
			const button = bar.createEl("button", { text: label[action] });
			button.addEventListener("click", () => void this.run(action));
		}
	}

	/** Single entry point into VaultOps. Guards, dispatches, reports. */
	private async run(action: EntryAction): Promise<void> {
		const group = this.group;
		if (!group || this.busy) return;

		const blocked = blockingPaths(group, openPathsIn(this.app.workspace));
		if (blocked.length > 0) {
			new Notice(`Close ${blocked.join(", ")} first. A pending editor save could overwrite the result.`);
			return;
		}

		this.busy = true;
		try {
			const resolved = await this.dispatch(action);
			await this.afterResolve();
			if (resolved) this.leaf.detach();
		} catch (error) {
			this.report(error);
		} finally {
			this.busy = false;
		}
	}

	/** Every copy in the group, as TFiles that still exist. */
	private allCopyFiles(): TFile[] {
		return (this.group?.copies ?? [])
			.map((c) => this.app.vault.getAbstractFileByPath(c.path))
			.filter((f): f is TFile => f instanceof TFile);
	}

	private async archiveAll(files: TFile[]): Promise<void> {
		const results = await this.ops().moveAllToRecovery(files);
		const failed = results.filter((r) => r.status === "failed").length;
		new Notice(
			failed === 0
				? `Moved ${results.length} to recovery.`
				: `Moved ${results.length - failed}, ${failed} failed. Nothing was deleted.`,
		);
	}

	/** Returns whether the group is resolved and the tab should close. */
	private async dispatch(action: EntryAction): Promise<boolean> {
		const group = this.group;
		if (!group) return false;
		const copy = this.copyFile();
		const original = this.originalFile();

		if (action === "keep-original" || action === "accept-deletion") {
			await this.archiveAll(this.allCopyFiles());
			return true;
		}

		if (action === "keep-copy") {
			if (!original || !copy || this.reviewedOriginal === null || this.reviewedCopy === null) return false;
			await this.ops().replaceOriginal(original, this.reviewedOriginal, this.reviewedCopy);
			// Spec: ALL copies move to recovery, the kept one included.
			await this.archiveAll(this.allCopyFiles());
			new Notice(`${group.originalPath} now holds the selected copy.`);
			return true;
		}

		if (action === "restore-copy") {
			if (!copy) return false;
			// restoreTo archives the copy it restored; the remaining ones follow.
			await this.ops().restoreTo(copy, group.originalPath);
			const rest = this.allCopyFiles();
			if (rest.length > 0) await this.archiveAll(rest);
			new Notice(`Restored ${group.originalPath}.`);
			return true;
		}

		if (action === "save-as-new") {
			if (!copy || this.reviewedCopy === null) return false;
			const device = group.copies[this.selectedCopy].deviceId;
			const target = `${group.originalPath.replace(/\.md$/, "")} (from ${device}).md`;
			// Through VaultOps: this file may not call vault.create. See boundaries.test.ts.
			await this.ops().createNew(target, this.reviewedCopy);
			// Deliberately resolves nothing: both inputs stay and the group is
			// rediscovered on the next scan. Say so, and keep the tab open.
			new Notice(`Saved ${target}. The conflict is still unresolved.`);
			return false;
		}

		return false;
	}

	private report(error: unknown): void {
		if (error instanceof StaleInput) {
			new Notice("That file changed while you were reviewing it. Nothing was written. Rescan and try again.");
		} else if (
			error instanceof RestoreArchiveFailed ||
			error instanceof DestinationOccupied ||
			error instanceof UnsafePath
		) {
			new Notice(String((error as Error).message));
		} else {
			new Notice(`That did not work: ${String(error)}`);
		}
	}
```

- [ ] **Step 4: Wire it into `src/main.ts`**

```ts
this.registerView(
	CONFLICT_COMPARE_VIEW,
	(leaf) => new ConflictCompareView(leaf, () => this.ops, () => this.rescan()),
);
```

```ts
async openCompareView(group: ConflictGroup): Promise<void> {
	const leaf = this.app.workspace.getLeaf(true);
	await leaf.setViewState({ type: CONFLICT_COMPARE_VIEW, active: true });
	await (leaf.view as ConflictCompareView).setGroup(group);
}
```

Construct `VaultOps` in `onload()` after settings load, **and rebuild it whenever the folder
moves**. `VaultOps` takes the folder in its constructor, so a settings change leaves the old
instance archiving into the previous directory while `scanConflicts` excludes the new one:

```ts
private rebuildOps(): void {
	this.ops = new VaultOps(this.app, this.settings.recoveryFolder);
}

async saveSettings(): Promise<void> {
	await this.saveData(this.settings);
	this.rebuildOps();
	await this.rescan(); // the exclusion root moved, so the group list changes too
}
```

Call `rebuildOps()` once in `onload()` after `loadSettings()`. Views hold `() => this.ops`, so
they pick up the new instance without being re-registered.

- [ ] **Step 5: Add the styles**

Append to `styles.css`:

```css
.conflict-panel button,
.conflict-compare button,
.conflict-recovery button {
	/* 48dp minimum touch target: this plugin runs on Android. */
	min-height: 48px;
}
.conflict-panel__entry,
.conflict-compare__copies button {
	width: 100%;
	text-align: left;
	margin-bottom: 6px;
}
.conflict-compare__actions button { width: auto; padding: 0 16px; margin-right: 8px; }
.conflict-compare__warning { color: var(--text-warning); font-weight: 600; }
.conflict-compare__diff { font-family: var(--font-monospace); font-size: 0.85em; overflow-x: auto; }
.conflict-compare__hunk { border-left: 2px solid var(--background-modifier-border); padding-left: 8px; margin: 8px 0; }
.conflict-compare__line.is-left { background: var(--background-modifier-error); }
.conflict-compare__line.is-right { background: var(--background-modifier-success); }
@media (max-width: 600px) {
	.conflict-compare__actions button { width: 100%; margin: 0 0 8px 0; }
}
```

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run build && npm run lint`
Expected: all pass, `boundaries` included.

```bash
git add src/compare-view.ts src/main.ts styles.css
git commit -m "feat: compare view with guarded actions into VaultOps"
```

The commit body must state that this file has no unit tests, because `ItemView` cannot be
instantiated outside Obsidian.

---

### Task 7: `src/recovery-view.ts`

Reads archived artifacts through `DataAdapter`, because unsupported extensions may not be in
the vault tree and `getAbstractFileByPath` would report them absent.

**Restore here copies; it does not move.** The first draft used `adapter.exists` followed by
`adapter.rename`, which is check-then-act — the pattern removed from core restore over three
review rounds — and `rename` has no documented no-clobber guarantee. Instead the artifact is
read and written through `VaultOps.createNew`, and **the artifact stays where it is.** Nothing
in recovery is ever removed by this plugin, which the view already tells the user. That
deletes the race rather than guarding it.

**Files:**
- Create: `src/recovery-view.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Implement `src/recovery-view.ts`**

```ts
import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { DestinationOccupied, UnsafePath, VaultOps } from "./vault-ops";
import { isSafeVaultPath } from "./core/safe-path";

export const CONFLICT_RECOVERY_VIEW = "conflict-panel-recovery";

interface Artifact {
	path: string;
	sourcePath: string;
	bytes: number;
	/** False when the decoded path would escape the vault. See isSafeVaultPath. */
	safe: boolean;
}

export class ConflictRecoveryView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		// Accessors, not snapshots: saveSettings() can move the recovery folder while
		// this view is open, and a captured value would list the wrong directory.
		private readonly ops: () => VaultOps,
		private readonly recoveryFolder: () => string,
	) {
		super(leaf);
	}

	getViewType(): string { return CONFLICT_RECOVERY_VIEW; }
	getDisplayText(): string { return "Conflict recovery"; }
	getIcon(): string { return "archive"; }

	async onOpen(): Promise<void> {
		await this.render();
	}

	/**
	 * Enumerate through the ADAPTER, not the Vault.
	 *
	 * `.conflictbak` is an unsupported extension, so Obsidian may not load it into
	 * the vault tree when "Show all file types" is off. A TFile-based listing would
	 * show an empty folder that is not empty.
	 */
	private async listArtifacts(): Promise<Artifact[]> {
		const adapter = this.app.vault.adapter;
		const root = this.recoveryFolder();
		if (!(await adapter.exists(root))) return [];
		const found: Artifact[] = [];
		const walk = async (dir: string): Promise<void> => {
			const listing = await adapter.list(dir);
			for (const file of listing.files) {
				if (!file.endsWith(".conflictbak")) continue;
				const stat = await adapter.stat(file);
				// Takes a full path: sourcePathFromRecovery slices at the last "/".
				const sourcePath = VaultOps.sourcePathFromRecovery(file);
				found.push({
					path: file,
					sourcePath,
					bytes: stat?.size ?? 0,
					// A filename Syncthing delivered, not one we necessarily wrote.
					safe: isSafeVaultPath(sourcePath),
				});
			}
			for (const sub of listing.folders) await walk(sub);
		};
		await walk(root);
		return found;
	}

	private async render(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		const artifacts = await this.listArtifacts();

		const total = artifacts.reduce((n, a) => n + a.bytes, 0);
		root.createEl("h4", {
			text: `${artifacts.length} recovered ${artifacts.length === 1 ? "file" : "files"}, ${Math.round(total / 1024)} KB`,
		});
		root.createEl("p", {
			text: "Nothing here is ever deleted automatically. Restoring copies a file back; the archive stays until you remove it yourself.",
		});

		for (const artifact of artifacts) {
			const item = root.createDiv({ cls: "conflict-panel__item" });
			item.createDiv({ text: artifact.sourcePath, cls: "conflict-panel__path" });
			if (!artifact.safe) {
				// No button at all. An unsafe path gets an explanation, never a control
				// that would have to refuse when pressed.
				item.createDiv({
					text: `This archive names a path outside the vault, so it cannot be copied back here. The file itself is intact at ${artifact.path}.`,
					cls: "conflict-compare__warning",
				});
				continue;
			}
			item
				.createEl("button", { text: "Copy back to its original path" })
				.addEventListener("click", () => void this.restore(artifact));
		}
	}

	private async restore(artifact: Artifact): Promise<void> {
		try {
			const content = await this.app.vault.adapter.read(artifact.path);
			// createNew is the only write path a view gets, and `create` inside it is
			// the sole no-clobber guard. No exists()-then-write here.
			await this.ops().createNew(artifact.sourcePath, content);
			new Notice(`Copied back to ${artifact.sourcePath}. The archive is still in recovery.`);
			await this.render();
		} catch (error) {
			if (error instanceof DestinationOccupied) {
				new Notice(`${artifact.sourcePath} already exists. Nothing was written.`);
			} else if (error instanceof UnsafePath) {
				new Notice(String(error.message));
			} else {
				new Notice(`Could not restore: ${String(error)}`);
			}
		}
	}
}
```

- [ ] **Step 2: Register and add a command in `src/main.ts`**

```ts
this.registerView(
	CONFLICT_RECOVERY_VIEW,
	(leaf) => new ConflictRecoveryView(leaf, () => this.ops, () => this.settings.recoveryFolder),
);

this.addCommand({
	id: "open-recovery",
	name: "Open conflict recovery",
	callback: () => void this.openRecovery(),
});
```

- [ ] **Step 3: Verify and commit**

Run: `npm test && npm run build && npm run lint`
Expected: all pass.

```bash
git add src/recovery-view.ts src/main.ts
git commit -m "feat: recovery list that copies artifacts back without deleting them"
```

The commit body must state that this file has no unit tests, and that restore deliberately
leaves the archive in place.

---

## Self-Review

**Spec coverage.** The sidebar list with a count, the main-tab diff, the authoritative action
matrix, the editor guard, the Recovery list, 48dp targets, visible text labels, device-ID
labelling, and save-as-new stating that it resolves nothing all have a task. Every `VaultOps`
entry point is reached through exactly one guarded method, `run()`.

**Four corrections after the worker rejected the first draft.** All four were real:

| defect in the first draft | fix |
|---|---|
| `toHunks` called inside `renderDiff` | computed in `loadSelection`, rendered from stored state |
| no guard for accepted-but-large input, which the spec requires | Task 3 `needsConfirmation` plus a "Compare anyway" button |
| `vault.create` in two views, which `boundaries.test.ts` fails | Task 4 `VaultOps.createNew` |
| `keep-copy` and `restore-copy` archived only the selected copy | both archive every copy, per the spec matrix |

A fifth followed from the third: recovery restore was `adapter.exists` then `adapter.rename`,
check-then-act with no no-clobber guarantee. Restore now copies and leaves the archive alone,
which removes the race instead of guarding it.

**Three more after the second rejection.** Also all real:

| defect in the second draft | fix |
|---|---|
| `VaultOps` captured once, stale after `saveSettings` moves the recovery folder | views take `() => VaultOps`; `main.ts` rebuilds it and rescans on save |
| overlapping `loadSelection` reads could pair copy B's selection with copy A's text | a `loadToken` generation guard; no field is assigned until the read proves current |
| a decoded artifact path is a filename on disk and can be `../outside.md` | `isSafeVaultPath` rejects it, `createNew` throws `UnsafePath` before any vault call, and the row is listed with no restore button |

The third is the serious one. `..%2Foutside.md.conflictbak` is an ordinary filename that
Syncthing will deliver, and `sourcePathFromRecovery` decodes it straight to `../outside.md`.

**Known gaps this plan does not close, deliberately:**
- The three views have no unit tests. Obsidian's `ItemView` cannot be instantiated outside the
  app, so `scan.ts`, `editor-guard.ts`, `core/diff.ts` and `vault-ops.ts` are tested and the
  views are not. State it in the commits rather than glossing.
- Nothing is verified on a real device. Every claim about touch targets and mobile layout is
  from CSS, not from an Android session.
- `needsConfirmation` scans for newlines a second time after `toHunks` would. Two passes over
  at most 100,000 chars is not worth sharing a helper across the module boundary.

**Type consistency.** `ConflictGroup`, `EntryAction`, `DiffResult` and `RecoveryMoveResult` are
used exactly as `src/core/` and `src/vault-ops.ts` define them at `bf66329`.
