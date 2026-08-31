import { describe, expect, it, vi } from "vitest";

const { MockTFile, MockTFolder } = vi.hoisted(() => ({
	MockTFile: class {
		constructor(readonly path: string) {}
	},
	MockTFolder: class {
		constructor(readonly path: string) {}
	},
}));

vi.mock("obsidian", () => ({ TFile: MockTFile, TFolder: MockTFolder }));

import { buildVaultIndex, scanConflicts } from "./scan";

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

describe("scanConflicts", () => {
	it("returns groups found in the loaded vault entries", () => {
		const copy = "note.sync-conflict-20260830-143000-AAA.md";
		const vault = {
			getAllLoadedFiles: () => [new MockTFile("note.md"), new MockTFile(copy)],
		};

		const groups = scanConflicts(vault as never, "Conflict Recovery");

		expect(groups).toHaveLength(1);
		expect(groups[0]?.originalPath).toBe("note.md");
		expect(groups[0]?.copies.map((entry) => entry.path)).toEqual([copy]);
	});

	it("excludes copies under the CONFIGURED recovery folder, not a hardcoded one", () => {
		// Kills ignoring the argument: with the folder renamed, every archive inside
		// it would be rediscovered as a fresh conflict on the next scan.
		const archived = "My Archive/note.sync-conflict-20260830-143000-AAA.md";
		const vault = {
			getAllLoadedFiles: () => [new MockTFile("note.md"), new MockTFile(archived)],
		};

		expect(scanConflicts(vault as never, "My Archive")).toHaveLength(0);
		expect(scanConflicts(vault as never, "Conflict Recovery")).not.toHaveLength(0);
	});
});
