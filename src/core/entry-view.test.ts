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
