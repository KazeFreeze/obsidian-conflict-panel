import type { App, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { StaleInput, VaultOps } from "./vault-ops";

const file = (path: string): TFile => ({ path }) as TFile;

// These fakes establish our control flow and preconditions only. They cannot
// prove rename atomicity, cache invalidation, editor behaviour, process death,
// or races against a real Obsidian adapter.

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
	it("creates the original with the copy content before archiving the copy", async () => {
		const copy = file("copy.md");
		const read = vi.fn(async () => "copy contents");
		const create = vi.fn(async (path: string) => file(path));
		const rename = vi.fn(async () => undefined);
		const app = {
			vault: {
				adapter: {
					exists: vi.fn(async (path: string) => path === "Recovery"),
					mkdir: vi.fn(async () => undefined),
				},
				read,
				create,
				rename,
			},
		} as unknown as App;

		await new VaultOps(app, "Recovery").restoreTo(copy, "original.md");

		expect(read).toHaveBeenCalledWith(copy);
		expect(create).toHaveBeenCalledWith("original.md", "copy contents");
		expect(rename).toHaveBeenCalledWith(copy, "Recovery/copy.md.conflictbak");
	});

	it("does not archive the copy when no-clobber creation fails", async () => {
		const occupied = new Error("already exists");
		const create = vi.fn(async () => Promise.reject(occupied));
		const rename = vi.fn(async () => undefined);
		const app = {
			vault: {
				read: vi.fn(async () => "copy contents"),
				create,
				rename,
			},
		} as unknown as App;

		await expect(
			new VaultOps(app, "Recovery").restoreTo(file("copy.md"), "original.md"),
		).rejects.toBe(occupied);
		expect(rename).not.toHaveBeenCalled();
	});
});

describe("VaultOps content replacement", () => {
	it("rejects stale reviewed text without returning replacement content", async () => {
		const replacements: string[] = [];
		const process = vi.fn(
			async (_original: TFile, update: (current: string) => string) => {
				replacements.push(update("changed since review"));
			},
		);
		const app = { vault: { process } } as unknown as App;

		await expect(
			new VaultOps(app, "Recovery").replaceOriginal(
				file("original.md"),
				"reviewed text",
				"chosen text",
			),
		).rejects.toBeInstanceOf(StaleInput);
		expect(replacements).toEqual([]);
	});
});

describe("VaultOps batch recovery", () => {
	it("reports one failed move and continues with the remaining copies", async () => {
		const rename = vi.fn(async (copy: TFile) => {
			if (copy.path === "bad.md") throw new Error("move failed");
		});
		const app = {
			vault: {
				adapter: {
					exists: vi.fn(async (path: string) => path === "Recovery"),
					mkdir: vi.fn(async () => undefined),
				},
				rename,
			},
		} as unknown as App;

		const results = await new VaultOps(app, "Recovery").moveAllToRecovery([
			file("first.md"),
			file("bad.md"),
			file("last.md"),
		]);

		expect(rename).toHaveBeenCalledTimes(3);
		expect(results.map((result) => result.status)).toEqual(["moved", "failed", "moved"]);
		const failed = results[1];
		expect(failed?.status).toBe("failed");
		if (failed?.status !== "failed") return;
		expect(failed.copy.path).toBe("bad.md");
		expect(failed.error).toBeInstanceOf(Error);
	});
});

describe("VaultOps recovery folder", () => {
	it("creates every missing parent for a nested recovery folder", async () => {
		const mkdir = vi.fn(async (_path: string) => undefined);
		const app = {
			vault: {
				adapter: {
					exists: vi.fn(async () => false),
					mkdir,
				},
				rename: vi.fn(async () => undefined),
			},
		} as unknown as App;

		await new VaultOps(app, "Archive/Conflicts/2026").moveToRecovery(file("note.md"));

		expect(mkdir.mock.calls.map(([path]) => path)).toEqual([
			"Archive",
			"Archive/Conflicts",
			"Archive/Conflicts/2026",
		]);
	});
});
