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
