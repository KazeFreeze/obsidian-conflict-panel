import { describe, expect, it } from "vitest";
import { blockingPaths, openPathsIn } from "./editor-guard";

/** Fake workspace: iterateAllLeaves visits every leaf, including sidebars and pop-outs. */
const workspace = (paths: (string | null)[]) => ({
	iterateAllLeaves(cb: (leaf: { view: { file?: { path: string } } }) => void) {
		for (const p of paths) cb({ view: p ? { file: { path: p } } : {} });
	},
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
