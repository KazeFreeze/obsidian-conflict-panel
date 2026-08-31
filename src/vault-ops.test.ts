import type { App, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ArchiveNameTooLong, StaleInput, VaultOps } from "./vault-ops";

const file = (path: string): TFile => ({ path }) as TFile;

// This in-memory fake establishes exact path/content outcomes and control flow.
// It cannot prove rename atomicity, cache invalidation, editor behaviour, process
// death, or races against a real Obsidian adapter.
class FakeVault {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly renameFailures = new Set<string>();

	readonly adapter = {
		exists: vi.fn(async (path: string) => this.files.has(path) || this.folders.has(path)),
		mkdir: vi.fn(async (path: string) => {
			this.folders.add(path);
		}),
	};
	readonly read = vi.fn(async (source: TFile) => {
		const content = this.files.get(source.path);
		if (content === undefined) throw new Error(`Missing file: ${source.path}`);
		return content;
	});
	readonly create = vi.fn(async (path: string, content: string) => {
		if (this.files.has(path) || this.folders.has(path)) throw new Error(`Occupied: ${path}`);
		this.files.set(path, content);
		return file(path);
	});
	readonly process = vi.fn(async (source: TFile, update: (current: string) => string) => {
		const current = this.files.get(source.path);
		if (current === undefined) throw new Error(`Missing file: ${source.path}`);
		this.files.set(source.path, update(current));
	});
	readonly rename = vi.fn(async (source: TFile, target: string) => {
		if (this.renameFailures.has(source.path)) throw new Error(`Move failed: ${source.path}`);
		const content = this.files.get(source.path);
		if (content === undefined) throw new Error(`Missing file: ${source.path}`);
		// Model the overwrite-prone adapter semantics documented by VaultOps.
		this.files.set(target, content);
		this.files.delete(source.path);
	});

	constructor(entries: ReadonlyArray<readonly [string, string]> = []) {
		for (const [path, content] of entries) this.files.set(path, content);
	}

	asApp(): App {
		return { vault: this } as unknown as App;
	}
}

async function archiveAtCollision(sourcePath: string, collisionNumber: number): Promise<string> {
	const encoded = `${sourcePath.replace(/%/g, "%25").replace(/\//g, "%2F")}.conflictbak`;
	const vault = new FakeVault([[sourcePath, "new losing version"]]);
	vault.folders.add("Recovery");
	if (collisionNumber > 1) vault.files.set(`Recovery/${encoded}`, "archive 1");
	for (let n = 2; n < collisionNumber; n++) {
		vault.folders.add(`Recovery/${n}`);
		vault.files.set(`Recovery/${n}/${encoded}`, `archive ${n}`);
	}

	const target = await new VaultOps(vault.asApp(), "Recovery").moveToRecovery(file(sourcePath));
	expect(vault.files.get(target)).toBe("new losing version");
	expect(vault.files.has(sourcePath)).toBe(false);
	return target;
}

describe("VaultOps recovery path encoding", () => {
	it.each([
		{ source: "a/b/note.md", collision: 1 },
		{ source: "a/b/note.md", collision: 2 },
		{ source: "a/b/note.md", collision: 10 },
		{ source: "a/%/note.md", collision: 1 },
		{ source: "a/%00/note.md", collision: 2 },
	])("round-trips $source at collision $collision", async ({ source, collision }) => {
		const recoveryPath = await archiveAtCollision(source, collision);
		if (collision > 1) expect(recoveryPath.startsWith(`Recovery/${collision}/`)).toBe(true);
		expect(VaultOps.sourcePathFromRecovery(recoveryPath)).toBe(source);
	});

	it("keeps a 252-byte archive basename unchanged at the second collision", async () => {
		const source = `${"a/".repeat(58)}xnote.md`;
		const recoveryPath = await archiveAtCollision(source, 2);
		const archiveName = recoveryPath.slice(recoveryPath.lastIndexOf("/") + 1);
		expect(new TextEncoder().encode(archiveName)).toHaveLength(252);
		expect(recoveryPath.startsWith("Recovery/2/")).toBe(true);
	});

	it.each([
		["ASCII", "x".repeat(244)],
		["multi-byte", `${"😀".repeat(62)}.md`],
	])("rejects an overlong %s archive name before rename", async (_kind, source) => {
		const vault = new FakeVault([[source, "content"]]);
		await expect(
			new VaultOps(vault.asApp(), "Recovery").moveToRecovery(file(source)),
		).rejects.toBeInstanceOf(ArchiveNameTooLong);
		expect(vault.rename).not.toHaveBeenCalled();
		expect(vault.files.get(source)).toBe("content");
	});
});

describe("VaultOps restore", () => {
	it("creates the original and archives the same copy content", async () => {
		const vault = new FakeVault([["copy.md", "copy contents"]]);
		await new VaultOps(vault.asApp(), "Recovery").restoreTo(file("copy.md"), "original.md");
		expect(vault.files.get("original.md")).toBe("copy contents");
		expect(vault.files.get("Recovery/copy.md.conflictbak")).toBe("copy contents");
		expect(vault.files.has("copy.md")).toBe(false);
	});

	it("leaves occupied original and copy unchanged when create fails", async () => {
		const vault = new FakeVault([
			["copy.md", "copy contents"],
			["original.md", "existing original"],
		]);
		await expect(
			new VaultOps(vault.asApp(), "Recovery").restoreTo(file("copy.md"), "original.md"),
		).rejects.toThrow("Occupied: original.md");
		expect(vault.files.get("original.md")).toBe("existing original");
		expect(vault.files.get("copy.md")).toBe("copy contents");
		expect(vault.files.has("Recovery/copy.md.conflictbak")).toBe(false);
	});
});

describe("VaultOps content replacement", () => {
	it("runs the stale check inside process and preserves changed content", async () => {
		const vault = new FakeVault([["original.md", "changed since review"]]);
		await expect(
			new VaultOps(vault.asApp(), "Recovery").replaceOriginal(
				file("original.md"),
				"reviewed text",
				"chosen text",
			),
		).rejects.toBeInstanceOf(StaleInput);
		expect(vault.process).toHaveBeenCalledTimes(1);
		expect(vault.files.get("original.md")).toBe("changed since review");
	});

	it("stores chosen content when reviewed content is still current", async () => {
		const vault = new FakeVault([["original.md", "reviewed text"]]);
		await new VaultOps(vault.asApp(), "Recovery").replaceOriginal(
			file("original.md"),
			"reviewed text",
			"chosen text",
		);
		expect(vault.files.get("original.md")).toBe("chosen text");
	});
});

describe("VaultOps batch recovery", () => {
	it("moves successful copies to exact targets and leaves the failed copy", async () => {
		const vault = new FakeVault([
			["first.md", "first content"],
			["bad.md", "bad content"],
			["last.md", "last content"],
		]);
		vault.renameFailures.add("bad.md");
		const results = await new VaultOps(vault.asApp(), "Recovery").moveAllToRecovery([
			file("first.md"),
			file("bad.md"),
			file("last.md"),
		]);
		expect(results.map((result) => result.status)).toEqual(["moved", "failed", "moved"]);
		expect(vault.files.get("Recovery/first.md.conflictbak")).toBe("first content");
		expect(vault.files.get("bad.md")).toBe("bad content");
		expect(vault.files.has("Recovery/bad.md.conflictbak")).toBe(false);
		expect(vault.files.get("Recovery/last.md.conflictbak")).toBe("last content");
		expect(vault.files.has("first.md")).toBe(false);
		expect(vault.files.has("last.md")).toBe(false);
	});
});

describe("VaultOps recovery folder", () => {
	it("creates every parent and moves content to the exact nested target", async () => {
		const vault = new FakeVault([["note.md", "note content"]]);
		const target = await new VaultOps(vault.asApp(), "Archive/Conflicts/2026").moveToRecovery(
			file("note.md"),
		);
		expect([...vault.folders]).toEqual([
			"Archive",
			"Archive/Conflicts",
			"Archive/Conflicts/2026",
		]);
		expect(target).toBe("Archive/Conflicts/2026/note.md.conflictbak");
		expect(vault.files.get(target)).toBe("note content");
		expect(vault.files.has("note.md")).toBe(false);
	});
});
