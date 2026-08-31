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
