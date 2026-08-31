import { TFile, type App } from "obsidian";
import { isSafeVaultPath } from "./core/safe-path";

/** Thrown when the file changed between review and write. Aborts cleanly. */
export class StaleInput extends Error {
	constructor(path: string) {
		super(`${path} changed since you reviewed it. Nothing was written.`);
	}
}

/** Thrown when a destination is occupied. Never overwrite what nobody reviewed. */
export class DestinationOccupied extends Error {
	constructor(path: string) {
		super(`${path} already exists. Nothing was moved.`);
	}
}

/** Thrown before an adapter call when an encoded archive basename is too long. */
export class ArchiveNameTooLong extends Error {
	constructor(path: string, bytes: number) {
		super(`The recovery name for ${path} is ${bytes} UTF-8 bytes; the limit is 255.`);
	}
}

/** Thrown before any vault access when a write target is not vault-relative. */
export class UnsafePath extends Error {
	constructor(readonly path: string) {
		super(`${path} is not a canonical vault-relative path. Nothing was written.`);
	}
}

/** Restore succeeded, but its non-destructive archival cleanup did not. */
export class RestoreArchiveFailed extends Error {
	constructor(
		readonly originalPath: string,
		readonly copyPath: string,
		readonly cause: unknown,
	) {
		super(
			`Restored ${originalPath} successfully. The conflict copy ${copyPath} could not be moved to recovery, so the restored file and conflict copy are both present. Move or delete the copy yourself when convenient.`,
		);
	}
}

export type RecoveryMoveResult =
	| { copy: TFile; status: "moved"; recoveryPath: string }
	| { copy: TFile; status: "failed"; error: unknown };

export class VaultOps {
	constructor(
		private readonly app: App,
		private readonly recoveryFolder: string,
	) {}

	/**
	 * Replace the original's content with a chosen copy.
	 *
	 * The equality check runs INSIDE the process callback, which the Obsidian
	 * typings document as an atomic read-modify-save. Checking beforehand would
	 * leave a window; checking inside is the precondition.
	 */
	async replaceOriginal(
		original: TFile,
		reviewedText: string,
		chosenText: string,
	): Promise<void> {
		await this.app.vault.process(original, (current) => {
			if (current !== reviewedText) throw new StaleInput(original.path);
			return chosenText;
		});
	}

	/**
	 * Create a file at a safe path that must be empty.
	 *
	 * The lookup rejects known occupancy. Obsidian's create repeats an existence
	 * check before adapter.write, so it is the best available narrow-window guard,
	 * not an atomic one: an external writer can still land between those two calls.
	 */
	async createNew(path: string, content: string): Promise<void> {
		if (!isSafeVaultPath(path)) throw new UnsafePath(path);
		if (this.app.vault.getAbstractFileByPath(path)) throw new DestinationOccupied(path);
		await this.app.vault.create(path, content);
	}

	/**
	 * Move a conflict copy into the recovery folder.
	 *
	 * A MOVE, never copy-then-delete. Whatever the file holds at rename time is
	 * what survives. The checked destination narrows but cannot close a race: a
	 * concurrent archive can make rename overwrite a previously archived losing
	 * version. That older archive is real data and can be lost.
	 */
	async moveToRecovery(copy: TFile): Promise<string> {
		await this.ensureFolder(this.recoveryFolder);
		const target = await this.freePath(this.recoveryPathFor(copy.path));
		const targetFolder = target.slice(0, target.lastIndexOf("/"));
		if (targetFolder !== this.recoveryFolder) await this.ensureFolder(targetFolder);
		await this.app.vault.rename(copy, target);
		return target;
	}

	/** Move every copy independently so one adapter failure cannot abort the batch. */
	async moveAllToRecovery(copies: TFile[]): Promise<RecoveryMoveResult[]> {
		const results: RecoveryMoveResult[] = [];
		for (const copy of copies) {
			try {
				const recoveryPath = await this.moveToRecovery(copy);
				results.push({ copy, status: "moved", recoveryPath });
			} catch (error) {
				results.push({ copy, status: "failed", error });
			}
		}
		return results;
	}

	/** Restore with the best available occupied-path guard. */
	async restoreTo(copy: TFile, originalPath: string): Promise<void> {
		const content = await this.app.vault.read(copy);
		// This lookup only recognizes a destination already occupied; it never
		// authorizes the write. create() repeats an existence check, but its later
		// adapter.write can still race an external writer. No plugin API can lock
		// Syncthing out of that narrow window.
		const existing = this.app.vault.getAbstractFileByPath(originalPath);
		// Any occupant aborts, file or folder alike. Round three tried to treat an
		// identical-content file as proof of its own earlier create; byte equality
		// cannot establish that, so every occupied destination now aborts cleanly.
		if (existing) throw new DestinationOccupied(originalPath);
		// Obsidian exposes no typed create error. An occupancy race, permissions,
		// and an invalid path therefore remain distinct only as their raw causes.
		await this.app.vault.create(originalPath, content);
		try {
			await this.moveToRecovery(copy);
		} catch (cause) {
			throw new RestoreArchiveFailed(originalPath, copy.path, cause);
		}
	}

	/**
	 * Archive name: `<percent-encoded source path>.conflictbak`
	 *
	 * The full path is encoded rather than reduced to a basename, because two
	 * `note.md` in different folders would otherwise collide in one batch. The
	 * encoding is REVERSIBLE so restore can reconstruct the real path; a hash
	 * could not, which is the contradiction this replaced.
	 */
	private recoveryPathFor(sourcePath: string): string {
		// Percent-style and REVERSIBLE, because restore has to reconstruct the real
		// path from this name. Escape the escape character first: a naive `/`->`__`
		// makes `a__b/note.md` and `a/b__note.md` collide.
		const flat = sourcePath.replace(/%/g, "%25").replace(/\//g, "%2F");
		const archiveName = `${flat}.conflictbak`;
		const bytes = new TextEncoder().encode(archiveName).byteLength;
		if (bytes > 255) throw new ArchiveNameTooLong(sourcePath, bytes);
		return `${this.recoveryFolder}/${archiveName}`;
	}

	/** Inverse of every path freePath can produce, including collision folders. */
	static sourcePathFromRecovery(recoveryName: string): string {
		const slash = recoveryName.lastIndexOf("/");
		const archiveName = recoveryName.slice(slash + 1);
		// Order matters: remove framing first, then reverse source-path escaping.
		const withoutExtension = archiveName.replace(/\.conflictbak$/, "");
		return withoutExtension
			.replace(/%2F/g, "/")
			.replace(/%25/g, "%");
	}

	/**
	 * Find a free destination.
	 *
	 * Uses the ADAPTER, not `getAbstractFileByPath`. Unsupported extensions may not
	 * be loaded into Obsidian's vault tree, so the Vault API would report an
	 * existing `.conflictbak` as absent and we would rename over it.
	 * The stat-to-rename race remains. A concurrent archive can occupy the checked
	 * path and be overwritten, losing that previously archived losing version.
	 */
	private async freePath(base: string): Promise<string> {
		if (!(await this.app.vault.adapter.stat(base))) return base;
		const slash = base.lastIndexOf("/");
		const parent = base.slice(0, slash);
		const archiveName = base.slice(slash + 1);
		for (let n = 2; n < 1000; n++) {
			// Keep collision counters out of the basename so collisions cannot push
			// an otherwise valid 255-byte archive name over the component limit. A
			// regular file named `n` cannot serve as a bucket, so advance past it.
			const bucket = `${parent}/${n}`;
			const bucketStat = await this.app.vault.adapter.stat(bucket);
			if (bucketStat?.type === "file") continue;
			const candidate = `${bucket}/${archiveName}`;
			if (!(await this.app.vault.adapter.stat(candidate))) return candidate;
		}
		throw new DestinationOccupied(base);
	}

	private async ensureFolder(path: string): Promise<void> {
		// DataAdapter.mkdir is not documented as recursive. Build parents in order.
		let current = "";
		for (const segment of path.split("/").filter(Boolean)) {
			current = current ? `${current}/${segment}` : segment;
			const stat = await this.app.vault.adapter.stat(current);
			if (!stat) {
				await this.app.vault.adapter.mkdir(current);
			} else if (stat.type !== "folder") throw new DestinationOccupied(current);
		}
	}
}
