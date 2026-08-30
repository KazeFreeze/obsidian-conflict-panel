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
		expect(g[0]!.originalPath).toBe("note.md");
		expect(g[0]!.shape).toBe("normal");
		expect(g[0]!.copies).toHaveLength(1);
	});

	it("attaches a copy-of-a-copy to the true original", () => {
		const deep = "n.sync-conflict-20260101-010101-AAA.sync-conflict-20260202-020202-BBB.md";
		const g = groupConflicts(["n.md", deep], vault(["n.md", deep]), "Conflict Recovery");
		expect(g[0]!.originalPath).toBe("n.md");
	});

	it("marks a group orphan when the original is absent", () => {
		const c = "gone.sync-conflict-20260830-143000-AAA.md";
		const g = groupConflicts([c], vault([c]), "Conflict Recovery");
		expect(g[0]!.shape).toBe("orphan");
	});

	it("marks non-markdown groups opaque", () => {
		const c = "img.sync-conflict-20260830-143000-AAA.png";
		const g = groupConflicts(["img.png", c], vault(["img.png", c]), "Conflict Recovery");
		expect(g[0]!.shape).toBe("opaque");
	});

	it("folder precedence beats opaque", () => {
		const c = "thing.sync-conflict-20260830-143000-AAA.png";
		const g = groupConflicts([c], vault([c], ["thing.png"]), "Conflict Recovery");
		expect(g[0]!.shape).toBe("blocked");
	});

	it("ignores anything inside the recovery folder", () => {
		const c = "Conflict Recovery/x.sync-conflict-20260830-143000-AAA.md";
		expect(groupConflicts([c], vault([c]), "Conflict Recovery")).toHaveLength(0);
	});

	it.each([
		"Conflict Recovery/",
		"/Conflict Recovery",
		"//Conflict Recovery///",
	])("normalises recovery setting separators in %j", (recoveryFolder) => {
		const c = "Conflict Recovery/x.sync-conflict-20260830-143000-AAA.md";
		expect(groupConflicts([c], vault([c]), recoveryFolder)).toHaveLength(0);
	});

	it("collapses doubled separators inside the recovery setting", () => {
		const c = "Archive/Conflicts/x.sync-conflict-20260830-143000-AAA.md";
		expect(groupConflicts([c], vault([c]), "Archive//Conflicts")).toHaveLength(0);
	});

	it("does not exclude a sibling whose name merely shares the prefix", () => {
		const c = "Conflict Recovery-old/x.sync-conflict-20260830-143000-AAA.md";
		expect(groupConflicts([c], vault([c]), "Conflict Recovery/")).toHaveLength(1);
	});

	it("collects several copies under one original, oldest first", () => {
		const a = "note.sync-conflict-20260830-090000-AAA.md";
		const b = "note.sync-conflict-20260830-143000-BBB.md";
		const g = groupConflicts(["note.md", b, a], vault(["note.md", a, b]), "Conflict Recovery");
		expect(g[0]!.copies.map((c) => c.deviceId)).toEqual(["AAA", "BBB"]);
	});
});
