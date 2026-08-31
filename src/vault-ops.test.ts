import type { App, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ArchiveNameTooLong, DestinationOccupied, StaleInput, VaultOps } from "./vault-ops";

const { MockTFile } = vi.hoisted(() => ({
	MockTFile: class {
		constructor(readonly path: string) {}
	},
}));

vi.mock("obsidian", () => ({ TFile: MockTFile }));

const file = (path: string): TFile => new MockTFile(path) as TFile;

// This in-memory fake establishes exact path/content outcomes and control flow.
// It cannot prove rename atomicity, cache invalidation, editor behaviour, process
// death, or races against a real Obsidian adapter.
class FakeVault {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly renameFailures = new Map<string, Error>();
	createFailure: Error | null = null;

	readonly adapter = {
		exists: vi.fn(async (path: string) => this.files.has(path) || this.folders.has(path)),
		stat: vi.fn(async (path: string) => {
			if (this.files.has(path)) return { type: "file" as const, ctime: 0, mtime: 0, size: 0 };
			if (this.folders.has(path)) return { type: "folder" as const, ctime: 0, mtime: 0, size: 0 };
			return null;
		}),
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
		if (this.createFailure) throw this.createFailure;
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
		const failure = this.renameFailures.get(source.path);
		if (failure) throw failure;
		const content = this.files.get(source.path);
		if (content === undefined) throw new Error(`Missing file: ${source.path}`);
		// Model the overwrite-prone adapter semantics documented by VaultOps.
		this.files.set(target, content);
		this.files.delete(source.path);
	});
	readonly getAbstractFileByPath = vi.fn((path: string) => {
		if (this.files.has(path)) return file(path);
		if (this.folders.has(path)) return { path };
		return null;
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
	if (collisionNumber > 1) expect(vault.files.get(`Recovery/${encoded}`)).toBe("archive 1");
	for (let n = 2; n < collisionNumber; n++) {
		expect(vault.files.get(`Recovery/${n}/${encoded}`)).toBe(`archive ${n}`);
	}
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

	it("skips a collision bucket occupied by a regular file", async () => {
		const archiveName = "note.md.conflictbak";
		const vault = new FakeVault([
			["note.md", "new losing version"],
			[`Recovery/${archiveName}`, "archive 1"],
			["Recovery/2", "ordinary file named 2"],
		]);
		vault.folders.add("Recovery");

		const target = await new VaultOps(vault.asApp(), "Recovery").moveToRecovery(file("note.md"));

		expect(target).toBe(`Recovery/3/${archiveName}`);
		expect(vault.files.get(target)).toBe("new losing version");
		expect(vault.files.get("Recovery/2")).toBe("ordinary file named 2");
		expect(vault.files.get(`Recovery/${archiveName}`)).toBe("archive 1");
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
		).rejects.toBeInstanceOf(DestinationOccupied);
		expect(vault.files.get("original.md")).toBe("existing original");
		expect(vault.files.get("copy.md")).toBe("copy contents");
		expect(vault.files.has("Recovery/copy.md.conflictbak")).toBe(false);
	});

	it("reports a folder at the original path as occupied", async () => {
		const vault = new FakeVault([["copy.md", "copy contents"]]);
		vault.folders.add("original.md");

		await expect(
			new VaultOps(vault.asApp(), "Recovery").restoreTo(file("copy.md"), "original.md"),
		).rejects.toBeInstanceOf(DestinationOccupied);
		expect(vault.create).not.toHaveBeenCalled();
		expect(vault.files.get("copy.md")).toBe("copy contents");
	});

	it("preserves an unclassified create failure as its raw cause", async () => {
		const permissions = new Error("permission denied");
		const vault = new FakeVault([["copy.md", "copy contents"]]);
		vault.createFailure = permissions;

		await expect(
			new VaultOps(vault.asApp(), "Recovery").restoreTo(file("copy.md"), "original.md"),
		).rejects.toBe(permissions);
		expect(vault.files.get("copy.md")).toBe("copy contents");
		expect(vault.files.has("original.md")).toBe(false);
	});

	it("retries only archival when a prior restore already created identical content", async () => {
		const vault = new FakeVault([["copy.md", "copy contents"]]);
		const archiveFailure = new Error("archive unavailable");
		vault.renameFailures.set("copy.md", archiveFailure);
		const ops = new VaultOps(vault.asApp(), "Recovery");

		await expect(ops.restoreTo(file("copy.md"), "original.md")).rejects.toBe(archiveFailure);
		expect(vault.files.get("original.md")).toBe("copy contents");
		expect(vault.files.get("copy.md")).toBe("copy contents");
		expect(vault.files.has("Recovery/copy.md.conflictbak")).toBe(false);
		expect(vault.create).toHaveBeenCalledTimes(1);

		vault.renameFailures.delete("copy.md");
		await ops.restoreTo(file("copy.md"), "original.md");

		expect(vault.create).toHaveBeenCalledTimes(1);
		expect(vault.files.get("original.md")).toBe("copy contents");
		expect(vault.files.get("Recovery/copy.md.conflictbak")).toBe("copy contents");
		expect(vault.files.has("copy.md")).toBe(false);
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
		const first = file("first.md");
		const bad = file("bad.md");
		const last = file("last.md");
		const moveFailure = new Error("bad move failed");
		vault.renameFailures.set("bad.md", moveFailure);
		const results = await new VaultOps(vault.asApp(), "Recovery").moveAllToRecovery([
			first,
			bad,
			last,
		]);
		expect(results).toEqual([
			{
				copy: first,
				status: "moved",
				recoveryPath: "Recovery/first.md.conflictbak",
			},
			{ copy: bad, status: "failed", error: moveFailure },
			{
				copy: last,
				status: "moved",
				recoveryPath: "Recovery/last.md.conflictbak",
			},
		]);
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

	it("rejects a configured parent segment that is a regular file", async () => {
		const vault = new FakeVault([
			["note.md", "note content"],
			["Archive", "ordinary file"],
		]);

		await expect(
			new VaultOps(vault.asApp(), "Archive/Conflicts").moveToRecovery(file("note.md")),
		).rejects.toThrow("Archive already exists");
		expect(vault.files.get("Archive")).toBe("ordinary file");
		expect(vault.files.get("note.md")).toBe("note content");
	});
});
