import type { App, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DestinationOccupied, VaultOps } from "./vault-ops";

const file = (path: string): TFile => ({ path }) as TFile;

async function archiveAtCollision(sourcePath: string, collisionNumber: number): Promise<string> {
	let candidateChecks = 0;
	const rename = vi.fn(async (_copy: TFile, target: string) => target);
	const app = {
		vault: {
			adapter: {
				exists: vi.fn(async (path: string) => {
					if (path === "Recovery") return true;
					candidateChecks++;
					return candidateChecks < collisionNumber;
				}),
				mkdir: vi.fn(async () => undefined),
			},
			rename,
		},
	} as unknown as App;

	const target = await new VaultOps(app, "Recovery").moveToRecovery(file(sourcePath));
	expect(rename).toHaveBeenCalledWith(expect.objectContaining({ path: sourcePath }), target);
	return target;
}

describe("VaultOps recovery path encoding", () => {
	it.each([
		{ source: "a/b/note.md", collision: 1, marker: null },
		{ source: "a/b/note.md", collision: 2, marker: "%002" },
		{ source: "a/b/note.md", collision: 10, marker: "%0010" },
		{ source: "a/%/note.md", collision: 1, marker: null },
		{ source: "a/%00/note.md", collision: 2, marker: "%002" },
	])("round-trips $source at collision $collision", async ({ source, collision, marker }) => {
		const recoveryPath = await archiveAtCollision(source, collision);

		if (marker) expect(recoveryPath).toContain(`${marker}.conflictbak`);
		expect(VaultOps.sourcePathFromRecovery(recoveryPath)).toBe(source);
	});
});

describe("VaultOps restore", () => {
	it("re-checks the destination immediately before rename", async () => {
		const exists = vi
			.fn<(path: string) => Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const rename = vi.fn(async () => undefined);
		const app = {
			vault: { adapter: { exists }, rename },
		} as unknown as App;

		await expect(
			new VaultOps(app, "Recovery").restoreTo(file("copy.md"), "original.md"),
		).rejects.toBeInstanceOf(DestinationOccupied);
		expect(exists).toHaveBeenCalledTimes(2);
		expect(rename).not.toHaveBeenCalled();
	});
});
