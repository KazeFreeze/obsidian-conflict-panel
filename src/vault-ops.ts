import type { App, TFile } from "obsidian";

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

	/** Restore without clobber: create first, then archive the still-existing copy. */
	async restoreTo(copy: TFile, originalPath: string): Promise<void> {
		const content = await this.app.vault.read(copy);
		// Vault.create throws if occupied. Only archive after atomic no-clobber
		// creation succeeds, so every later failure leaves a duplicate, not loss.
		await this.app.vault.create(originalPath, content);
		await this.moveToRecovery(copy);
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
