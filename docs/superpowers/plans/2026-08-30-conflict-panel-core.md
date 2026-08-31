# Conflict Panel — core phase implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tested decision core and vault-operations layer for that plugin. **This is not a
usable plugin.** It deliberately stops before the UI, so nothing calls `VaultOps` and the plugin
cannot touch a vault. The sidebar, compare view, Recovery list and editor guard are a second plan.

**Known UI limitation:** `toHunks` is synchronous and bounded-but-blocking. The later compare-view
plan must not call it on the main thread for accepted-but-large input without its own guard.

The full v0.1 product is described in the spec; this plan builds roughly its lower half.

**Architecture:** Pure decision modules under `src/core/` with no `obsidian` import, unit-tested with vitest. A thin Obsidian shell wires them to views. `src/vault-ops.ts` is the only module permitted to mutate the vault, and the plugin calls no deletion API at all. The recovery folder is the single place using `DataAdapter`, because unsupported files may not be in Obsidian's vault tree.

**Tech Stack:** TypeScript, esbuild, vitest, `diff` (jsdiff), Obsidian API 1.13.x.

**Spec:** `docs/superpowers/specs/2026-08-30-conflict-panel-design.md` (rev 8).

---

## File Structure

| file | responsibility |
|---|---|
| `src/core/detect.ts` | Parse one path into a conflict record or null. Pure string work. |
| `src/core/group.ts` | Files → `ConflictGroup[]`, recursive suffix stripping, shape precedence. |
| `src/core/entry-view.ts` | Group → the actions the UI may offer. Actions derive from shape. |
| `src/core/diff.ts` | jsdiff wrapper → hunks, display only. |
| `src/core/types.ts` | Shared types for the above. No logic. |
| `src/vault-ops.ts` | The only mutating module. Vault for notes, Adapter for recovery. |
| `src/panel-view.ts` | Sidebar `ItemView`: group list and count. |
| `src/compare-view.ts` | Main-tab `ItemView`: diff and action buttons. |
| `src/main.ts` | Lifecycle, commands, view registration. |

`core/` never imports `obsidian`. That is enforced by a test in Task 6, not by convention.

---

### Task 1: De-template the repo and add vitest

The repo is still `obsidianmd/obsidian-sample-plugin`. Nothing below works until the identity and toolchain are right.

**Files:**
- Modify: `manifest.json`, `package.json`, `README.md`, `versions.json`
- Replace: `src/main.ts`, `src/settings.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: Rewrite `manifest.json`**

```json
{
	"id": "conflict-panel",
	"name": "Conflict Panel",
	"version": "0.1.0",
	"minAppVersion": "1.1.0",
	"description": "Find and resolve Syncthing sync-conflict files without leaving Obsidian.",
	"author": "Bernard G. Tapiru, Jr.",
	"authorUrl": "https://github.com/KazeFreeze",
	"isDesktopOnly": false
}
```

`minAppVersion` is 1.1.0 because `Vault.process` was introduced there. No trash API is used, so 1.6.6 is not required.

- [ ] **Step 2: Update `package.json` identity and add vitest**

Change `"name"` to `"obsidian-conflict-panel"`, `"version"` to `"0.1.0"`, then add to `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Then install:

```bash
npm install --save-dev vitest
npm install --save diff @types/diff
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
```

- [ ] **Step 4: Replace `src/settings.ts`**

```ts
import { App, normalizePath, PluginSettingTab, Setting } from "obsidian";
import type ConflictPanelPlugin from "./main";

export interface ConflictPanelSettings {
	/** Vault-relative folder that resolved conflict copies are moved into. */
	recoveryFolder: string;
}

export const DEFAULT_SETTINGS: ConflictPanelSettings = {
	recoveryFolder: "Conflict Recovery",
};

/** Canonicalize once where settings enter the application. */
export function normalizeRecoveryFolder(value: string): string {
	const canonical = normalizePath(value.trim())
		.split("/")
		.filter((segment) => segment && segment !== ".")
		.join("/");
	return canonical || DEFAULT_SETTINGS.recoveryFolder;
}

export class ConflictPanelSettingTab extends PluginSettingTab {
	plugin: ConflictPanelPlugin;

	constructor(app: App, plugin: ConflictPanelPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Recovery folder")
			.setDesc(
				"Resolved conflict copies are moved here. Nothing is ever deleted, so this folder grows until you empty it yourself.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Conflict Recovery")
					.setValue(this.plugin.settings.recoveryFolder)
					.onChange(async (value) => {
						this.plugin.settings.recoveryFolder = normalizeRecoveryFolder(value);
						await this.plugin.saveSettings();
					}),
			);
	}
}
```

- [ ] **Step 5: Replace `src/main.ts` with a minimal shell**

```ts
import { Plugin } from "obsidian";
import {
	ConflictPanelSettings,
	ConflictPanelSettingTab,
	DEFAULT_SETTINGS,
	normalizeRecoveryFolder,
} from "./settings";

export default class ConflictPanelPlugin extends Plugin {
	// Definite-assignment assertion: strict mode cannot see that onload() assigns
	// this, because the assignment is async and outside the constructor. Without
	// the `!` the build fails with TS2564. The official sample plugin does the same.
	settings!: ConflictPanelSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new ConflictPanelSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ConflictPanelSettings>,
		);
		this.settings.recoveryFolder = normalizeRecoveryFolder(this.settings.recoveryFolder);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
```

- [ ] **Step 5a: Test settings-boundary normalization**

Mock only Obsidian's actual `normalizePath` behavior in `src/settings.test.ts`; the mock must not
remove `.` segments. Assert that leading and repeated separators and `Archive\\Conflicts` are
canonicalized, while plugin-owned processing handles `Archive/./Conflicts`, `./Conflicts`,
`Conflicts/.`, `a/./b/./c`, and a value made entirely of dot/empty segments. The last case falls
back to the default. Core grouping receives only this canonical value and must not implement a
second normalizer.

- [ ] **Step 6: Replace `README.md`**

```markdown
# Conflict Panel

Find and resolve Syncthing `*.sync-conflict-*` files without leaving Obsidian.

**This plugin never deletes anything.** Resolving a conflict moves the losing copy
into a recovery folder. Emptying that folder is left to you.

Design notes and the reasoning behind that constraint are in
`docs/superpowers/specs/`.

## Status

v0.1 in development. Not yet released.
```

- [ ] **Step 7: Reset `versions.json`**

```json
{
	"0.1.0": "1.1.0"
}
```

- [ ] **Step 8: Verify the build and lint still pass**

Run: `npm run build && npm run lint`
Expected: both exit 0. `main.js` is produced.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: de-template, add vitest and plugin identity"
```

---

### Task 2: `core/types.ts` and `core/detect.ts`

**Files:**
- Create: `src/core/types.ts`, `src/core/detect.ts`, `src/core/detect.test.ts`

- [ ] **Step 1: Create `src/core/types.ts`**

```ts
/** One parsed `*.sync-conflict-*` filename. Paths are vault-relative strings. */
export interface ParsedConflict {
	/** Path this copy conflicts with, after stripping ONE suffix. */
	parentPath: string;
	/** Syncthing's short device ID, NOT the friendly name. There is no mapping. */
	deviceId: string;
	/** YYYYMMDD as written in the filename. */
	date: string;
	/** HHMMSS as written in the filename. */
	time: string;
}

export type ConflictShape =
	/** Original exists, is `.md`. Diffable and resolvable. */
	| "normal"
	/** Original absent. Syncthing's edit-versus-delete. */
	| "orphan"
	/** Not `.md`. Listed and movable, never diffed or promoted. */
	| "opaque"
	/** Canonical path holds a folder. View-only. */
	| "blocked";

export interface ConflictGroup {
	/** The canonical path all copies resolve to. */
	originalPath: string;
	shape: ConflictShape;
	/** At least one. Sorted by date+time ascending. */
	copies: ParsedConflictFile[];
}

export interface ParsedConflictFile extends ParsedConflict {
	/** Full vault-relative path of the conflict copy itself. */
	path: string;
}
```

- [ ] **Step 2: Write the failing test `src/core/detect.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseConflictPath } from "./detect";

describe("parseConflictPath", () => {
	it("parses a plain conflict filename", () => {
		expect(parseConflictPath("note.sync-conflict-20260830-143000-ABCDEF.md")).toEqual({
			parentPath: "note.md",
			deviceId: "ABCDEF",
			date: "20260830",
			time: "143000",
		});
	});

	it("keeps the folder path", () => {
		const r = parseConflictPath("a/b/note.sync-conflict-20260830-143000-ABCDEF.md");
		expect(r?.parentPath).toBe("a/b/note.md");
	});

	it("strips only the LAST suffix, so recursion can handle the rest", () => {
		const r = parseConflictPath(
			"n.sync-conflict-20260101-010101-AAA.sync-conflict-20260202-020202-BBB.md",
		);
		expect(r?.parentPath).toBe("n.sync-conflict-20260101-010101-AAA.md");
		expect(r?.deviceId).toBe("BBB");
	});

	it("handles a file with no extension", () => {
		const r = parseConflictPath("LICENSE.sync-conflict-20260830-143000-ABCDEF");
		expect(r?.parentPath).toBe("LICENSE");
	});

	it("returns null for an ordinary note", () => {
		expect(parseConflictPath("note.md")).toBeNull();
	});

	it("returns null when the timestamp is malformed", () => {
		expect(parseConflictPath("note.sync-conflict-2026-1430-ABCDEF.md")).toBeNull();
	});
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm test -- detect`
Expected: FAIL, `Failed to resolve import "./detect"`.

- [ ] **Step 4: Implement `src/core/detect.ts`**

```ts
import type { ParsedConflict } from "./types";

/**
 * Syncthing's conflict format: `<base>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<deviceId><ext>`
 *
 * The base group is GREEDY on purpose. A copy-of-a-copy carries several suffixes,
 * and greedy matching strips the RIGHTMOST one, which is the most recent. Callers
 * recurse to reach the true original.
 */
const CONFLICT_RE =
	/^(?<base>.+)\.sync-conflict-(?<date>\d{8})-(?<time>\d{6})-(?<device>[A-Z0-9]+)(?<ext>\.[^.]+)?$/;

export function parseConflictPath(path: string): ParsedConflict | null {
	const slash = path.lastIndexOf("/");
	const dir = slash === -1 ? "" : path.slice(0, slash + 1);
	const name = slash === -1 ? path : path.slice(slash + 1);

	const m = CONFLICT_RE.exec(name);
	if (!m?.groups) return null;

	const { base, date, time, device, ext } = m.groups;
	return {
		parentPath: `${dir}${base}${ext ?? ""}`,
		deviceId: device,
		date,
		time,
	};
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- detect`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/detect.ts src/core/detect.test.ts
git commit -m "feat(core): parse Syncthing conflict filenames"
```

---

### Task 3: `core/group.ts`

Groups copies under their true original by recursing, then assigns a shape using the precedence from the spec: folder wins, then non-`.md`, then absent original, then normal.

**Files:**
- Create: `src/core/group.ts`, `src/core/group.test.ts`

- [ ] **Step 1: Write the failing test `src/core/group.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { groupConflicts } from "./group";

/** Minimal view of the vault the grouper needs. Keeps core free of `obsidian`. */
const vault = (files: string[], folders: string[] = []) => ({
	files: new Set(files),
	folders: new Set(folders),
});

describe("groupConflicts", () => {
	it("pairs a copy with its original", () => {
		const g = groupConflicts(
			["note.md", "note.sync-conflict-20260830-143000-AAA.md"],
			vault(["note.md", "note.sync-conflict-20260830-143000-AAA.md"]),
			"Conflict Recovery",
		);
		expect(g).toHaveLength(1);
		expect(g[0].originalPath).toBe("note.md");
		expect(g[0].shape).toBe("normal");
		expect(g[0].copies).toHaveLength(1);
	});

	it("attaches a copy-of-a-copy to the true original", () => {
		const deep = "n.sync-conflict-20260101-010101-AAA.sync-conflict-20260202-020202-BBB.md";
		const g = groupConflicts(["n.md", deep], vault(["n.md", deep]), "Conflict Recovery");
		expect(g[0].originalPath).toBe("n.md");
	});

	it("marks a group orphan when the original is absent", () => {
		const c = "gone.sync-conflict-20260830-143000-AAA.md";
		const g = groupConflicts([c], vault([c]), "Conflict Recovery");
		expect(g[0].shape).toBe("orphan");
	});

	it("marks non-markdown groups opaque", () => {
		const c = "img.sync-conflict-20260830-143000-AAA.png";
		const g = groupConflicts(["img.png", c], vault(["img.png", c]), "Conflict Recovery");
		expect(g[0].shape).toBe("opaque");
	});

	it("folder precedence beats opaque", () => {
		const c = "thing.sync-conflict-20260830-143000-AAA.png";
		const g = groupConflicts([c], vault([c], ["thing.png"]), "Conflict Recovery");
		expect(g[0].shape).toBe("blocked");
	});

	it("ignores anything inside the recovery folder", () => {
		const c = "Conflict Recovery/x.sync-conflict-20260830-143000-AAA.md";
		expect(groupConflicts([c], vault([c]), "Conflict Recovery")).toHaveLength(0);
	});

	it("does not exclude a sibling whose name merely shares the prefix", () => {
		const c = "Conflict Recovery-old/x.sync-conflict-20260830-143000-AAA.md";
		expect(groupConflicts([c], vault([c]), "Conflict Recovery")).toHaveLength(1);
	});

	it("collects several copies under one original, oldest first", () => {
		const a = "note.sync-conflict-20260830-090000-AAA.md";
		const b = "note.sync-conflict-20260830-143000-BBB.md";
		const g = groupConflicts(["note.md", b, a], vault(["note.md", a, b]), "Conflict Recovery");
		expect(g[0].copies.map((c) => c.deviceId)).toEqual(["AAA", "BBB"]);
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- group`
Expected: FAIL, `Failed to resolve import "./group"`.

- [ ] **Step 3: Implement `src/core/group.ts`**

```ts
import { parseConflictPath } from "./detect";
import type { ConflictGroup, ConflictShape, ParsedConflictFile } from "./types";

/** What the grouper needs to know about the vault. The shell supplies this. */
export interface VaultIndex {
	files: Set<string>;
	folders: Set<string>;
}

/**
 * Strip conflict suffixes until the name stops changing.
 *
 * NOTE: this is deterministic but not always correct. A note deliberately named
 * `x.sync-conflict-20260101-010101-AAA.md` is indistinguishable, by filename alone,
 * from a copy of `x.md`. No filename-only rule can tell them apart, which is why the
 * UI always shows which files were paired and offers a view-only escape.
 */
function resolveOriginal(path: string): string {
	let current = path;
	for (;;) {
		const parsed = parseConflictPath(current);
		if (!parsed) return current;
		current = parsed.parentPath;
	}
}

function shapeFor(originalPath: string, index: VaultIndex): ConflictShape {
	if (index.folders.has(originalPath)) return "blocked";
	if (!originalPath.endsWith(".md")) return "opaque";
	if (!index.files.has(originalPath)) return "orphan";
	return "normal";
}

export function groupConflicts(
	paths: string[],
	index: VaultIndex,
	recoveryFolder: string,
): ConflictGroup[] {
	// Settings are canonicalized once at the Obsidian boundary. Core modules use
	// that value verbatim so detection, folder creation, and rename agree.
	const recoveryRoot = recoveryFolder;
	const prefix = `${recoveryRoot}/`;
	const byOriginal = new Map<string, ParsedConflictFile[]>();

	for (const path of paths) {
		// The recovery folder is excluded outright. The non-note extension is only
		// defence in depth; this exclusion is the real protection against the
		// plugin rediscovering its own artifacts.
		if (recoveryRoot && (path === recoveryRoot || path.startsWith(prefix))) continue;

		const parsed = parseConflictPath(path);
		if (!parsed) continue;

		const original = resolveOriginal(path);
		const list = byOriginal.get(original) ?? [];
		list.push({ ...parsed, path });
		byOriginal.set(original, list);
	}

	return [...byOriginal.entries()]
		.map(([originalPath, copies]) => ({
			originalPath,
			shape: shapeFor(originalPath, index),
			copies: copies.sort((a, b) =>
				`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`),
			),
		}))
		.sort((a, b) => a.originalPath.localeCompare(b.originalPath));
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- group`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/group.ts src/core/group.test.ts
git commit -m "feat(core): group conflict copies under their original"
```

---

### Task 4: `core/entry-view.ts`

Maps a group to the actions the UI may offer. Actions derive from **shape**, and an unrecognised shape falls through to view-only, so a future case can never wedge the panel into offering a destructive action.

**Files:**
- Create: `src/core/entry-view.ts`, `src/core/entry-view.test.ts`

- [ ] **Step 1: Write the failing test `src/core/entry-view.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { describeGroup } from "./entry-view";
import type { ConflictGroup } from "./types";

const group = (shape: ConflictGroup["shape"], n = 1): ConflictGroup => ({
	originalPath: "note.md",
	shape,
	copies: Array.from({ length: n }, (_, i) => ({
		path: `note.sync-conflict-2026083${i}-143000-AAA.md`,
		parentPath: "note.md",
		deviceId: "AAA",
		date: `2026083${i}`,
		time: "143000",
	})),
});

describe("describeGroup", () => {
	it("offers keep-original, keep-copy and save-as-new for a normal group", () => {
		expect(describeGroup(group("normal")).actions).toEqual([
			"keep-original",
			"keep-copy",
			"save-as-new",
		]);
	});

	it("offers restore and accept-deletion for an orphan", () => {
		expect(describeGroup(group("orphan")).actions).toEqual([
			"restore-copy",
			"accept-deletion",
		]);
	});

	it("offers only move for an opaque group, and never diffs it", () => {
		const v = describeGroup(group("opaque"));
		expect(v.actions).toEqual(["accept-deletion"]);
		expect(v.diffable).toBe(false);
	});

	it("offers nothing for a blocked group", () => {
		expect(describeGroup(group("blocked")).actions).toEqual([]);
	});

	it("falls through to view-only for an unknown shape", () => {
		const rogue = { ...group("normal"), shape: "future" as never };
		expect(describeGroup(rogue).actions).toEqual([]);
	});

	it("warns that restoring an orphan resurrects it everywhere", () => {
		expect(describeGroup(group("orphan")).warning).toMatch(/every device/i);
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- entry-view`
Expected: FAIL, `Failed to resolve import "./entry-view"`.

- [ ] **Step 3: Implement `src/core/entry-view.ts`**

```ts
import type { ConflictGroup } from "./types";

export type EntryAction =
	| "keep-original"
	| "keep-copy"
	| "save-as-new"
	| "restore-copy"
	| "accept-deletion";

export interface EntryView {
	actions: EntryAction[];
	diffable: boolean;
	/** Shown before any action that has consequences beyond this device. */
	warning: string | null;
	explanation: string | null;
}

export function describeGroup(group: ConflictGroup): EntryView {
	switch (group.shape) {
		case "normal":
			return {
				actions: ["keep-original", "keep-copy", "save-as-new"],
				diffable: true,
				warning: null,
				explanation: null,
			};

		case "orphan":
			return {
				actions: ["restore-copy", "accept-deletion"],
				diffable: false,
				warning:
					"Restoring recreates a file another device deliberately deleted. Syncthing will propagate that to every device.",
				explanation: "The original no longer exists. Another device deleted it.",
			};

		case "opaque":
			return {
				actions: ["accept-deletion"],
				diffable: false,
				warning: null,
				explanation:
					"Not a Markdown file, so it cannot be compared or promoted. Copies can be moved to recovery.",
			};

		case "blocked":
			return {
				actions: [],
				diffable: false,
				warning: null,
				explanation: "A folder occupies this path, so the conflict cannot be resolved here.",
			};

		default:
			// An unrecognised shape must never reach a destructive action.
			return { actions: [], diffable: false, warning: null, explanation: null };
	}
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- entry-view`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/entry-view.ts src/core/entry-view.test.ts
git commit -m "feat(core): derive allowed actions from group shape"
```

---

### Task 5: `core/diff.ts`

**Files:**
- Create: `src/core/diff.ts`, `src/core/diff.test.ts`

- [ ] **Step 1: Write the failing test `src/core/diff.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { toHunks } from "./diff";

describe("toHunks", () => {
	it("returns no hunks for identical text", () => {
		expect(toHunks("a\nb\n", "a\nb\n")).toEqual({
			status: "ok",
			hunks: [],
		});
	});

	it("reports an added line", () => {
		const result = toHunks("a\n", "a\nb\n");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const h = result.hunks;
		expect(h).toHaveLength(1);
		expect(h[0]!.right).toEqual(["b"]);
		expect(h[0]!.left).toEqual([]);
	});

	it("reports a changed line as left and right together", () => {
		const result = toHunks("gym at 6\n", "dentist 3pm\n");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const h = result.hunks;
		expect(h[0]!.left).toEqual(["gym at 6"]);
		expect(h[0]!.right).toEqual(["dentist 3pm"]);
	});

	it("rejects pathological input before diffing in well under a second", () => {
		const left = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n");
		const right = Array.from({ length: 5000 }, (_, i) => `r${i}`).join("\n");
		const started = performance.now();

		expect(toHunks(left, right, 100)).toEqual({ status: "too-large" });
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("completes accepted worst-case blocking work within 500ms", () => {
		const left = Array.from({ length: 1000 }, (_, i) => `left-${i}`).join("\n");
		const right = Array.from({ length: 1000 }, (_, i) => `right-${i}`).join("\n");
		const started = performance.now();

		expect(toHunks(left, right, 100).status).toBe("ok");
		// Measured worst case is about 180ms today; 500ms leaves CI headroom while
		// making a meaningful regression visible.
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("accepts exactly 1,000 newline-terminated lines", () => {
		const input = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join("\n") + "\n";
		expect(toHunks(input, input).status).toBe("ok");
	});

	it("rejects 1,001 newline-terminated lines", () => {
		const input = Array.from({ length: 1001 }, (_, i) => `line-${i}`).join("\n") + "\n";
		expect(toHunks(input, input)).toEqual({ status: "too-large" });
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- diff`
Expected: FAIL, `Failed to resolve import "./diff"`.

- [ ] **Step 3: Implement `src/core/diff.ts`**

```ts
import { diffLines } from "diff";

export interface Hunk {
	/** Lines present only on the left (the kept file). */
	left: string[];
	/** Lines present only on the right (the conflict copy). */
	right: string[];
}

export type DiffResult =
	| { status: "ok"; hunks: Hunk[] }
	| { status: "too-large" };

const DEFAULT_MAX_HUNKS = 500;
// These limits bound jsdiff's worst-case work while still covering ordinary notes.
// String length is UTF-16 code units, available in O(1); line counting exits early.
const MAX_INPUT_CHARS = 100_000;
const MAX_INPUT_LINES = 1_000;

const lines = (value: string): string[] =>
	value.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));

function inputTooLarge(value: string): boolean {
	if (value.length > MAX_INPUT_CHARS) return true;
	// Match lines(): a trailing newline does not create a displayed empty line.
	let lineCount = value.length === 0 ? 0 : 1;
	for (let i = 0; i < value.length - 1; i++) {
		if (value.charCodeAt(i) === 10 && ++lineCount > MAX_INPUT_LINES) return true;
	}
	return false;
}

/**
 * Synchronous line diff with bounded input and output. Oversized input is rejected
 * before jsdiff sees it, but accepted work is blocking: jsdiff does not expose a
 * chunked API. The UI maps `too-large` to "too large to compare here".
 */
export function toHunks(
	left: string,
	right: string,
	maxHunks: number = DEFAULT_MAX_HUNKS,
): DiffResult {
	if (inputTooLarge(left) || inputTooLarge(right)) return { status: "too-large" };

	const hunks: Hunk[] = [];
	let pending: Hunk | null = null;

	for (const part of diffLines(left, right)) {
		if (!part.added && !part.removed) {
			if (pending) {
				hunks.push(pending);
				pending = null;
			}
			if (hunks.length >= maxHunks) return { status: "ok", hunks };
			continue;
		}
		pending ??= { left: [], right: [] };
		if (part.removed) pending.left.push(...lines(part.value));
		if (part.added) pending.right.push(...lines(part.value));
	}

	if (pending) hunks.push(pending);
	return { status: "ok", hunks: hunks.slice(0, maxHunks) };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- diff`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/diff.ts src/core/diff.test.ts
git commit -m "feat(core): capped line diff for display"
```

---

### Task 6: `vault-ops.ts` and the boundary tests

The only mutating module. Two invariants are enforced by a test that reads the source of every other module, because a convention nobody checks will rot.

**Files:**
- Create: `src/vault-ops.ts`, `src/boundaries.test.ts`
- Create: `src/vault-ops.test.ts` for recovery-path round trips and writer behaviour

- [ ] **Step 1: Write the failing boundary test `src/boundaries.test.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname);

const DELETION_API_SPELLINGS = [
	/(?:\.(?:delete|trash|trashFile)|\[\s*["'](?:delete|trash|trashFile)["']\s*\])\s*(?:\?\.)?\s*(?:\(|\.bind\s*\()/,
];

const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? sources(join(dir, e.name))
			: e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
				? [join(dir, e.name)]
				: [],
	);

describe("boundaries", () => {
	it("core/ never imports obsidian, so it stays unit-testable", () => {
		for (const file of sources(join(SRC, "core"))) {
			expect(readFileSync(file, "utf8")).not.toMatch(/from ["']obsidian["']/);
		}
	});

	it("source has no common literal deletion API spellings", () => {
		// This is a spelling guard, not proof: it can false-positive in comments and
		// cannot recognise every alias or dynamically computed property.
		for (const file of sources(SRC)) {
			const text = readFileSync(file, "utf8");
			for (const spelling of DELETION_API_SPELLINGS) {
				expect(text).not.toMatch(spelling);
			}
		}
	});

	it("source has no common literal vault-mutation spellings outside vault-ops", () => {
		for (const file of sources(SRC)) {
			if (file.endsWith("vault-ops.ts")) continue;
			const text = readFileSync(file, "utf8");
			expect(text).not.toMatch(/vault\.(process|rename|create|modify)\s*\(/);
		}
	});

	it.each([
		"const remove = app.vault.delete.bind(app.vault);",
		'await app.vault["delete"](file);',
		"await vault.delete?.(file);",
		"await app.vault.trash(file);",
		"await fileManager.trashFile(file);",
	])("recognises deletion spelling in %j", (source) => {
		expect(DELETION_API_SPELLINGS.some((pattern) => pattern.test(source))).toBe(true);
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- boundaries`
Expected: FAIL, `ENOENT` on `src/core` is not expected (it exists); the failure will be the missing `vault-ops.ts` in the third test's scan, or a pass. If all three pass at this point, that is correct — they are guard tests. Proceed.

- [ ] **Step 3: Implement `src/vault-ops.ts`**

```ts
import { TFile, type App } from "obsidian";

/** Thrown when the file changed between review and write. Aborts cleanly. */
export class StaleInput extends Error {
	constructor(path: string) {
		super(`${path} changed since you reviewed it. Nothing was written.`);
	}
}

/** Thrown when a destination is occupied. Never overwrite what nobody reviewed. */
export class DestinationOccupied extends Error {
	constructor(path: string) {
		super(`${path} already exists. Nothing was moved.`);
	}
}

/** Thrown before an adapter call when an encoded archive basename is too long. */
export class ArchiveNameTooLong extends Error {
	constructor(path: string, bytes: number) {
		super(`The recovery name for ${path} is ${bytes} UTF-8 bytes; the limit is 255.`);
	}
}

export type RecoveryMoveResult =
	| { copy: TFile; status: "moved"; recoveryPath: string }
	| { copy: TFile; status: "failed"; error: unknown };

export class VaultOps {
	constructor(
		private readonly app: App,
		private readonly recoveryFolder: string,
	) {}

	/**
	 * Replace the original's content with a chosen copy.
	 *
	 * The equality check runs INSIDE the process callback, which the Obsidian
	 * typings document as an atomic read-modify-save. Checking beforehand would
	 * leave a window; checking inside is the precondition.
	 */
	async replaceOriginal(
		original: TFile,
		reviewedText: string,
		chosenText: string,
	): Promise<void> {
		await this.app.vault.process(original, (current) => {
			if (current !== reviewedText) throw new StaleInput(original.path);
			return chosenText;
		});
	}

	/**
	 * Move a conflict copy into the recovery folder.
	 *
	 * A MOVE, never copy-then-delete. Whatever the file holds at rename time is
	 * what survives. The checked destination narrows but cannot close a race: a
	 * concurrent archive can make rename overwrite a previously archived losing
	 * version. That older archive is real data and can be lost.
	 */
	async moveToRecovery(copy: TFile): Promise<string> {
		await this.ensureFolder(this.recoveryFolder);
		const target = await this.freePath(this.recoveryPathFor(copy.path));
		const targetFolder = target.slice(0, target.lastIndexOf("/"));
		if (targetFolder !== this.recoveryFolder) await this.ensureFolder(targetFolder);
		await this.app.vault.rename(copy, target);
		return target;
	}

	/** Move every copy independently so one adapter failure cannot abort the batch. */
	async moveAllToRecovery(copies: TFile[]): Promise<RecoveryMoveResult[]> {
		const results: RecoveryMoveResult[] = [];
		for (const copy of copies) {
			try {
				const recoveryPath = await this.moveToRecovery(copy);
				results.push({ copy, status: "moved", recoveryPath });
			} catch (error) {
				results.push({ copy, status: "failed", error });
			}
		}
		return results;
	}

	/** Restore without clobber, or finish archival after an identical partial restore. */
	async restoreTo(copy: TFile, originalPath: string): Promise<void> {
		const content = await this.app.vault.read(copy);
		// This lookup only recognizes a retry or a destination already occupied. It
		// NEVER authorizes the write and is not the old check-then-act scheme:
		// create() remains the sole no-clobber safety guard. If the path is empty
		// now but occupied before create runs, create throws and nothing is clobbered.
		const existing = this.app.vault.getAbstractFileByPath(originalPath);
		if (existing) {
			if (!(existing instanceof TFile)) throw new DestinationOccupied(originalPath);
			const existingContent = await this.app.vault.read(existing);
			if (existingContent !== content) throw new DestinationOccupied(originalPath);
			// A previous attempt completed create but failed to archive. Exact content
			// equality makes the remaining archival step safely retryable.
			await this.moveToRecovery(copy);
			return;
		}
		// Obsidian exposes no typed create error. An occupancy race, permissions,
		// and an invalid path therefore remain distinct only as their raw causes.
		await this.app.vault.create(originalPath, content);
		await this.moveToRecovery(copy);
	}

	/**
	 * Archive name: `<percent-encoded source path>.conflictbak`
	 *
	 * The full path is encoded rather than reduced to a basename, because two
	 * `note.md` in different folders would otherwise collide in one batch. The
	 * encoding is REVERSIBLE so restore can reconstruct the real path; a hash
	 * could not, which is the contradiction this replaced.
	 */
	private recoveryPathFor(sourcePath: string): string {
		// Percent-style and REVERSIBLE, because restore has to reconstruct the real
		// path from this name. Escape the escape character first: a naive `/`->`__`
		// makes `a__b/note.md` and `a/b__note.md` collide.
		const flat = sourcePath.replace(/%/g, "%25").replace(/\//g, "%2F");
		const archiveName = `${flat}.conflictbak`;
		const bytes = new TextEncoder().encode(archiveName).byteLength;
		if (bytes > 255) throw new ArchiveNameTooLong(sourcePath, bytes);
		return `${this.recoveryFolder}/${archiveName}`;
	}

	/** Inverse of every path freePath can produce, including collision folders. */
	static sourcePathFromRecovery(recoveryName: string): string {
		const slash = recoveryName.lastIndexOf("/");
		const archiveName = recoveryName.slice(slash + 1);
		// Order matters: remove framing first, then reverse source-path escaping.
		const withoutExtension = archiveName.replace(/\.conflictbak$/, "");
		return withoutExtension
			.replace(/%2F/g, "/")
			.replace(/%25/g, "%");
	}

	/**
	 * Find a free destination.
	 *
	 * Uses the ADAPTER, not `getAbstractFileByPath`. Unsupported extensions may not
	 * be loaded into Obsidian's vault tree, so the Vault API would report an
	 * existing `.conflictbak` as absent and we would rename over it.
	 * The stat-to-rename race remains. A concurrent archive can occupy the checked
	 * path and be overwritten, losing that previously archived losing version.
	 */
	private async freePath(base: string): Promise<string> {
		if (!(await this.app.vault.adapter.stat(base))) return base;
		const slash = base.lastIndexOf("/");
		const parent = base.slice(0, slash);
		const archiveName = base.slice(slash + 1);
		for (let n = 2; n < 1000; n++) {
			// Keep collision counters out of the basename so collisions cannot push
			// an otherwise valid 255-byte archive name over the component limit. A
			// regular file named `n` cannot serve as a bucket, so advance past it.
			const bucket = `${parent}/${n}`;
			const bucketStat = await this.app.vault.adapter.stat(bucket);
			if (bucketStat?.type === "file") continue;
			const candidate = `${bucket}/${archiveName}`;
			if (!(await this.app.vault.adapter.stat(candidate))) return candidate;
		}
		throw new DestinationOccupied(base);
	}

	private async ensureFolder(path: string): Promise<void> {
		// DataAdapter.mkdir is not documented as recursive. Build parents in order.
		let current = "";
		for (const segment of path.split("/").filter(Boolean)) {
			current = current ? `${current}/${segment}` : segment;
			const stat = await this.app.vault.adapter.stat(current);
			if (!stat) {
				await this.app.vault.adapter.mkdir(current);
			} else if (stat.type !== "folder") throw new DestinationOccupied(current);
		}
	}
}
```

- [ ] **Step 4: Add behavioural tests in `src/vault-ops.test.ts`**

Use an in-memory fake `App`/adapter that tracks path → content state. Cover the stale equality
precondition, collision folders 1, 2, and 10, literal `%` and `%00` round trips, the 255 UTF-8-byte
basename limit, successful and occupied restoration, nested parent creation, and
`moveAllToRecovery` continuing after one copy fails. Every case must assert which exact path holds
which content afterward—not only calls or fabricated status values—and stale replacement must prove
`vault.process` was invoked. State beside the fake that it establishes observable state and control
flow only: it cannot prove rename
atomicity, cache invalidation, editor behaviour, process death, or real-adapter races.

Include regressions where collision bucket `2` is a regular file (the archive must advance to `3`)
and where a configured recovery parent is a regular file (the copy must remain unmoved).
For restore, assert that a known file or folder produces `DestinationOccupied`, while an ambiguous
`vault.create` rejection is returned as the exact raw cause and leaves both paths unchanged.
Force archival to fail after create, assert the original and copy both hold the restored content,
then retry and prove create was not called again and only the copy was moved to its exact archive.
For every `moveAllToRecovery` result, assert the exact input `copy` object and its exact
`recoveryPath` or exact thrown `error`, not only statuses and final vault state. After placing a new
collision archive, re-assert the content of every older archive populated by the fixture.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. These source-spelling guards catch common literal deletion and mutation forms. They are not proof against aliases or computed access, and can false-positive on comments.

- [ ] **Step 6: Verify the build still type-checks**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/vault-ops.ts src/boundaries.test.ts
git commit -m "feat: vault operations with no-clobber moves and no deletion"
```

---

## Self-Review

**Spec coverage.** Detection, grouping with all four shapes and precedence, action derivation, bounded diffing, the atomic content replacement with its precondition, and no-clobber moves via the Adapter each have a task. Boundary spelling guards supplement review without claiming to prove the writer and no-deletion invariants. The recovery Adapter decision is implemented in `freePath` and `ensureFolder`.

**Not covered by this plan, deliberately:** `panel-view.ts`, `compare-view.ts`, the Recovery list UI, and wiring in `main.ts`. Those are UI and are the subject of a second plan, written once the core above is green. Tasks 1-6 produce a plugin that loads, has real identity, and carries a fully tested decision core.

**Known gap to carry into the UI plan:** the editor guard (`workspace.iterateAllLeaves()`) is a shell concern and appears in neither this plan nor `vault-ops.ts`. It must gate every call into `VaultOps` from the views.

**Type consistency.** `ParsedConflict`, `ParsedConflictFile`, `ConflictGroup`, `ConflictShape` and `EntryAction` are defined once in `core/types.ts` or `core/entry-view.ts` and used consistently. `groupConflicts` takes `VaultIndex`, which the shell builds from `vault.getFiles()` and `vault.getAllLoadedFiles()`.
