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

**`toHunks` blocks.** It is bounded but not cooperative: accepted input up to its thresholds
takes roughly 180ms of synchronous work. **Never call it during a render pass or an event
handler that must stay responsive.** Compute once when a group is opened, store the result,
and render from the stored value.

**The editor guard is this phase's job.** The core has no idea whether a file is open.
Nothing may call `VaultOps` while any file in the group is open in an editor, because a
pending editor autosave can overwrite the result. That guard does not exist yet and must be
built here.

**Every control needs a visible text label** and a ≥48dp touch target. Two buttons
distinguished only by a tooltip is the exact defect that made an audited plugin unusable on
Android.

**Decisions must not live only in the DOM.** Android can destroy and rebuild a view at any
`await`.

---

## File Structure

| file | responsibility |
|---|---|
| `src/scan.ts` | Build `VaultIndex` from the vault, call `groupConflicts`, cache the result. |
| `src/editor-guard.ts` | Answer "is any file in this group open in an editor?" Pure enough to test with a fake workspace. |
| `src/panel-view.ts` | Sidebar `ItemView`: the group list and count. |
| `src/compare-view.ts` | Main-tab `ItemView`: diff, actions, and the calls into `VaultOps`. |
| `src/recovery-view.ts` | Recovery list over `DataAdapter`, with restore. |
| `src/main.ts` | Registers views, commands, ribbon; owns the scan cache. |

---

### Task 1: `src/scan.ts`

**Files:**
- Create: `src/scan.ts`, `src/scan.test.ts`

- [ ] **Step 1: Write the failing test `src/scan.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { buildVaultIndex } from "./scan";

describe("buildVaultIndex", () => {
	it("separates files from folders", () => {
		const vault = {
			getAllLoadedFiles: () => [
				{ path: "note.md", extension: "md" },
				{ path: "folder", children: [] },
			],
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
import { TFile, TFolder, Vault } from "obsidian";
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

### Task 3: `src/panel-view.ts`

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
		await this.app.workspace.revealLeaf(existing[0]);
		return;
	}
	const leaf = this.app.workspace.getRightLeaf(false);
	if (!leaf) return;
	await leaf.setViewState({ type: CONFLICT_PANEL_VIEW, active: true });
	await this.rescan();
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

### Task 4: `src/compare-view.ts`

The only surface that calls `VaultOps`. Every action goes through the editor guard first.

**Files:**
- Create: `src/compare-view.ts`
- Modify: `src/main.ts`, `styles.css`

- [ ] **Step 1: Implement the view shell and the diff**

```ts
import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { toHunks } from "./core/diff";
import { describeGroup } from "./core/entry-view";
import type { ConflictGroup } from "./core/types";
import { blockingPaths, openPathsIn } from "./editor-guard";
import {
	DestinationOccupied,
	RestoreArchiveFailed,
	StaleInput,
	VaultOps,
} from "./vault-ops";

export const CONFLICT_COMPARE_VIEW = "conflict-panel-compare";

export class ConflictCompareView extends ItemView {
	private group: ConflictGroup | null = null;
	private selectedCopy = 0;
	/** Held OUTSIDE the DOM: Android can destroy and rebuild a view at any await. */
	private reviewedOriginal: string | null = null;
	private reviewedCopy: string | null = null;
	private busy = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly ops: VaultOps,
		private readonly afterResolve: () => Promise<void>,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CONFLICT_COMPARE_VIEW;
	}

	getDisplayText(): string {
		return this.group ? `Conflict: ${this.group.originalPath}` : "Conflict";
	}

	getIcon(): string {
		return "git-compare";
	}

	async setGroup(group: ConflictGroup): Promise<void> {
		this.group = group;
		this.selectedCopy = 0;
		await this.loadContents();
		this.render();
	}

	/**
	 * Read both sides ONCE and keep them. toHunks is bounded but BLOCKING —
	 * roughly 180ms of synchronous work at its thresholds — so it must never run
	 * during a render pass or an event handler.
	 */
	private async loadContents(): Promise<void> {
		const group = this.group;
		if (!group) return;
		const copy = this.copyFile();
		this.reviewedCopy = copy ? await this.app.vault.read(copy) : null;
		const original = this.originalFile();
		this.reviewedOriginal = original ? await this.app.vault.read(original) : null;
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

- [ ] **Step 2: Add the render method to the same class**

```ts
	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("conflict-compare");

		const group = this.group;
		if (!group) return;
		const view = describeGroup(group);

		root.createEl("h3", { text: group.originalPath });

		if (view.explanation) {
			root.createEl("p", { text: view.explanation, cls: "conflict-compare__explanation" });
		}
		if (view.warning) {
			root.createEl("p", { text: view.warning, cls: "conflict-compare__warning" });
		}

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
				this.selectedCopy = i;
				void this.loadContents().then(() => this.render());
			});
		});
	}

	private renderDiff(root: HTMLElement): void {
		const left = this.reviewedOriginal;
		const right = this.reviewedCopy;
		if (left === null || right === null) return;

		const result = toHunks(left, right);
		const box = root.createDiv({ cls: "conflict-compare__diff" });
		if (result.status === "too-large") {
			box.createEl("p", {
				text: "These files are too large to compare here. Open them side by side instead.",
			});
			return;
		}
		if (result.hunks.length === 0) {
			box.createEl("p", { text: "The two files have identical text." });
			return;
		}
		for (const hunk of result.hunks) {
			const el = box.createDiv({ cls: "conflict-compare__hunk" });
			for (const line of hunk.left) {
				el.createDiv({ text: line, cls: "conflict-compare__line is-left" });
			}
			for (const line of hunk.right) {
				el.createDiv({ text: line, cls: "conflict-compare__line is-right" });
			}
		}
	}
```

- [ ] **Step 3: Add the actions, each gated by the editor guard**

```ts
	private renderActions(root: HTMLElement, actions: readonly string[]): void {
		if (actions.length === 0) return;
		const bar = root.createDiv({ cls: "conflict-compare__actions" });
		const label: Record<string, string> = {
			"keep-original": "Keep the original",
			"keep-copy": "Keep this copy",
			"save-as-new": "Save this copy as a new note",
			"restore-copy": "Restore this copy",
			"accept-deletion": "Move copies to recovery",
		};
		for (const action of actions) {
			// Visible text, never an icon or a tooltip alone: this must work on touch.
			const button = bar.createEl("button", { text: label[action] ?? action });
			button.addEventListener("click", () => void this.run(action));
		}
	}

	/** Single entry point into VaultOps. Guards, then dispatches, then reports. */
	private async run(action: string): Promise<void> {
		const group = this.group;
		if (!group || this.busy) return;

		const blocked = blockingPaths(group, openPathsIn(this.app.workspace));
		if (blocked.length > 0) {
			new Notice(
				`Close ${blocked.join(", ")} first. A pending editor save could overwrite the result.`,
			);
			return;
		}

		this.busy = true;
		try {
			await this.dispatch(action);
			await this.afterResolve();
			this.leaf.detach();
		} catch (error) {
			this.report(error);
		} finally {
			this.busy = false;
		}
	}

	private async dispatch(action: string): Promise<void> {
		const group = this.group;
		if (!group) return;
		const copy = this.copyFile();
		const original = this.originalFile();

		if (action === "keep-original" || action === "accept-deletion") {
			const files = group.copies
				.map((c) => this.app.vault.getAbstractFileByPath(c.path))
				.filter((f): f is TFile => f instanceof TFile);
			const results = await this.ops.moveAllToRecovery(files);
			const failed = results.filter((r) => r.status === "failed").length;
			new Notice(
				failed === 0
					? `Moved ${results.length} to recovery.`
					: `Moved ${results.length - failed}, ${failed} failed. Nothing was deleted.`,
			);
			return;
		}

		if (action === "keep-copy") {
			if (!original || !copy || this.reviewedOriginal === null || this.reviewedCopy === null) return;
			await this.ops.replaceOriginal(original, this.reviewedOriginal, this.reviewedCopy);
			await this.ops.moveAllToRecovery([copy]);
			new Notice(`${group.originalPath} now holds the selected copy.`);
			return;
		}

		if (action === "restore-copy") {
			if (!copy) return;
			await this.ops.restoreTo(copy, group.originalPath);
			new Notice(`Restored ${group.originalPath}.`);
			return;
		}

		if (action === "save-as-new") {
			if (!copy || this.reviewedCopy === null) return;
			const target = `${group.originalPath.replace(/\.md$/, "")} (from ${group.copies[this.selectedCopy].deviceId}).md`;
			await this.app.vault.create(target, this.reviewedCopy);
			// Deliberately resolves nothing: both inputs stay and the group is
			// rediscovered on the next scan. Say so rather than implying otherwise.
			new Notice(`Saved ${target}. The conflict is still unresolved.`);
		}
	}

	private report(error: unknown): void {
		if (error instanceof StaleInput) {
			new Notice("That file changed while you were reviewing it. Nothing was written. Rescan and try again.");
		} else if (error instanceof RestoreArchiveFailed) {
			new Notice(String((error as Error).message));
		} else if (error instanceof DestinationOccupied) {
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
	(leaf) => new ConflictCompareView(leaf, this.ops, () => this.rescan()),
);
```

and

```ts
async openCompareView(group: ConflictGroup): Promise<void> {
	const leaf = this.app.workspace.getLeaf(true);
	await leaf.setViewState({ type: CONFLICT_COMPARE_VIEW, active: true });
	await (leaf.view as ConflictCompareView).setGroup(group);
}
```

Construct `VaultOps` in `onload()` after settings load:

```ts
this.ops = new VaultOps(this.app, this.settings.recoveryFolder);
```

- [ ] **Step 5: Add the styles**

Append to `styles.css`:

```css
.conflict-panel__entry,
.conflict-compare__actions button,
.conflict-compare__copies button {
	/* 48dp minimum touch target: this plugin runs on Android. */
	min-height: 48px;
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
Expected: all pass.

```bash
git add src/compare-view.ts src/main.ts styles.css
git commit -m "feat: compare view with guarded actions into VaultOps"
```

---

### Task 5: `src/recovery-view.ts`

Reads archived artifacts through `DataAdapter`, because unsupported extensions may not be in
the vault tree and `getAbstractFileByPath` would report them absent.

**Files:**
- Create: `src/recovery-view.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Implement `src/recovery-view.ts`**

```ts
import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { VaultOps } from "./vault-ops";

export const CONFLICT_RECOVERY_VIEW = "conflict-panel-recovery";

interface Artifact {
	path: string;
	sourcePath: string;
	bytes: number;
}

export class ConflictRecoveryView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly recoveryFolder: string,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CONFLICT_RECOVERY_VIEW;
	}

	getDisplayText(): string {
		return "Conflict recovery";
	}

	getIcon(): string {
		return "archive";
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	/**
	 * Enumerate through the ADAPTER, not the Vault.
	 *
	 * `.conflictbak` is an unsupported extension, so Obsidian may not load it into
	 * the vault tree at all when "Show all file types" is off. A TFile-based
	 * listing would show an empty folder that is not empty.
	 */
	private async listArtifacts(): Promise<Artifact[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.recoveryFolder))) return [];
		const found: Artifact[] = [];
		const walk = async (dir: string): Promise<void> => {
			const listing = await adapter.list(dir);
			for (const file of listing.files) {
				if (!file.endsWith(".conflictbak")) continue;
				const stat = await adapter.stat(file);
				found.push({
					path: file,
					sourcePath: VaultOps.sourcePathFromRecovery(file),
					bytes: stat?.size ?? 0,
				});
			}
			for (const sub of listing.folders) await walk(sub);
		};
		await walk(this.recoveryFolder);
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
			text: "Nothing here is ever deleted automatically. Remove these yourself when you no longer need them.",
		});

		for (const artifact of artifacts) {
			const item = root.createDiv({ cls: "conflict-panel__item" });
			item.createDiv({ text: artifact.sourcePath, cls: "conflict-panel__path" });
			item
				.createEl("button", { text: "Restore to its original path" })
				.addEventListener("click", () => void this.restore(artifact));
		}
	}

	private async restore(artifact: Artifact): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(artifact.sourcePath)) {
			new Notice(`${artifact.sourcePath} already exists. Nothing was moved.`);
			return;
		}
		try {
			await adapter.rename(artifact.path, artifact.sourcePath);
			new Notice(`Restored ${artifact.sourcePath}.`);
			await this.render();
		} catch (error) {
			new Notice(`Could not restore: ${String(error)}`);
		}
	}
}
```

- [ ] **Step 2: Register and add a command in `src/main.ts`**

```ts
this.registerView(
	CONFLICT_RECOVERY_VIEW,
	(leaf) => new ConflictRecoveryView(leaf, this.settings.recoveryFolder),
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
git commit -m "feat: recovery list reading archives through the adapter"
```

---

## Self-Review

**Spec coverage.** The sidebar list with a count, the main-tab diff, the action matrix, the
editor guard, the Recovery list, 48dp targets, visible text labels, device-ID labelling, and
save-as-new stating that it resolves nothing all have a task. Every `VaultOps` entry point is
reached through exactly one guarded method, `run()`.

**Known gaps this plan does not close, deliberately:**
- Verified: `VaultOps.sourcePathFromRecovery` is `static` and slices at the last `/` itself,
  so Task 5 may pass it a full adapter path unchanged.
- The views have no unit tests. Obsidian's `ItemView` cannot be instantiated outside the app,
  so `scan.ts` and `editor-guard.ts` are tested and the three views are not. That is a real
  coverage hole and should be stated in the commit rather than glossed.
- Nothing is verified on a real device. Every claim about touch targets and mobile layout is
  from CSS, not from an Android session.

**Type consistency.** `ConflictGroup`, `EntryAction`, `DiffResult` and `RecoveryMoveResult` are
used exactly as `src/core/` and `src/vault-ops.ts` define them today at `bf66329`.
