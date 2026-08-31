import { describe, expect, it } from "vitest";
import { blockingPaths, openPathsIn } from "./editor-guard";

/**
 * Fake leaves, matching the two real shapes.
 *
 * A LOADED leaf carries the file on its view. A DEFERRED one (any background tab
 * since Obsidian 1.7.2) has a DeferredView with no `file` at all, and the path is
 * only reachable through getViewState().
 */
type Leaf = {
	view: { file?: { path: string } };
	getViewState(): { state?: { file?: unknown } };
};

const loaded = (path: string): Leaf => ({
	view: { file: { path } },
	getViewState: () => ({ state: { file: path } }),
});

const deferred = (path: string): Leaf => ({
	view: {},
	getViewState: () => ({ state: { file: path } }),
});

const fileless = (): Leaf => ({ view: {}, getViewState: () => ({ state: {} }) });

/** Loaded, but the persisted state does not name the file. Both reads are needed. */
const viewOnly = (path: string): Leaf => ({
	view: { file: { path } },
	getViewState: () => ({ state: {} }),
});

const workspaceOf = (leaves: Leaf[]) => ({
	iterateAllLeaves(cb: (leaf: Leaf) => void) {
		for (const leaf of leaves) cb(leaf);
	},
});

/** Kept for the existing loaded-leaf cases below. */
const workspace = (paths: (string | null)[]) =>
	workspaceOf(paths.map((p) => (p ? loaded(p) : fileless())));

describe("openPathsIn with deferred leaves", () => {
	it("sees a file open in a BACKGROUND tab", () => {
		// The whole point of the guard: the note you are not looking at is exactly
		// the one whose pending autosave can overwrite the result.
		expect(openPathsIn(workspaceOf([deferred("note.md")]) as never)).toEqual(
			new Set(["note.md"]),
		);
	});

	it("still sees a file open in the foreground tab", () => {
		expect(openPathsIn(workspaceOf([loaded("note.md")]) as never)).toEqual(
			new Set(["note.md"]),
		);
	});

	it("reports a path once when both sources agree", () => {
		expect(openPathsIn(workspaceOf([loaded("note.md"), deferred("note.md")]) as never).size).toBe(1);
	});

	it("sees a loaded view whose persisted state does not name the file", () => {
		// Kills dropping the leaf.view.file read: view state is not guaranteed to
		// carry the path, so the guard needs BOTH sources, not just the newer one.
		expect(openPathsIn(workspaceOf([viewOnly("note.md")]) as never)).toEqual(
			new Set(["note.md"]),
		);
	});

	it("ignores a leaf whose view state holds no file", () => {
		expect(openPathsIn(workspaceOf([fileless()]) as never).size).toBe(0);
	});

	it("ignores a non-string file in view state", () => {
		const odd: Leaf = { view: {}, getViewState: () => ({ state: { file: { path: "x.md" } } }) };
		expect(openPathsIn(workspaceOf([odd]) as never).size).toBe(0);
	});
});

describe("blockingPaths", () => {
	it("reports which of a group's files are open", () => {
		const group = {
			originalPath: "note.md",
			shape: "normal" as const,
			copies: [{ path: "note.sync-conflict-20260830-143000-AAA.md" } as never],
		};
		expect(blockingPaths(group as never, new Set(["note.md"]))).toEqual(["note.md"]);
		expect(blockingPaths(group as never, new Set())).toEqual([]);
	});

	it("blocks when only a conflict copy is open", () => {
		const copyPath = "note.sync-conflict-20260830-143000-AAA.md";
		const group = {
			originalPath: "note.md",
			shape: "normal" as const,
			copies: [{ path: copyPath } as never],
		};

		expect(blockingPaths(group as never, new Set([copyPath]))).toEqual([copyPath]);
	});
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
