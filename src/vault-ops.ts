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
	 * what survives, so a racing writer cannot cause loss.
	 */
	async moveToRecovery(copy: TFile): Promise<string> {
		await this.ensureFolder(this.recoveryFolder);
		const target = await this.freePath(this.recoveryPathFor(copy.path));
		await this.app.vault.rename(copy, target);
		return target;
	}

	/** Restore an orphan copy onto its original path. Aborts if occupied. */
	async restoreTo(copy: TFile, originalPath: string): Promise<void> {
		if (await this.app.vault.adapter.exists(originalPath)) {
			// The original came back while the user was deciding. That turns an
			// orphan into an ordinary conflict; renaming over it would destroy a
			// note nobody reviewed.
			throw new DestinationOccupied(originalPath);
		}
		await this.app.vault.rename(copy, originalPath);
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
		return `${this.recoveryFolder}/${flat}.conflictbak`;
	}

	/** Inverse of every path freePath can produce, including collision markers. */
	static sourcePathFromRecovery(recoveryName: string): string {
		const slash = recoveryName.lastIndexOf("/");
		const archiveName = recoveryName.slice(slash + 1);
		// Order matters: remove framing first, then reverse source-path escaping.
		const withoutExtension = archiveName.replace(/\.conflictbak$/, "");
		const withoutMarker = withoutExtension.replace(/%00\d+$/, "");
		return withoutMarker
			.replace(/%2F/g, "/")
			.replace(/%25/g, "%");
	}

	/**
	 * Find a free destination.
	 *
	 * Uses the ADAPTER, not `getAbstractFileByPath`. Unsupported extensions may not
	 * be loaded into Obsidian's vault tree, so the Vault API would report an
	 * existing `.conflictbak` as absent and we would rename over it.
	 */
	private async freePath(base: string): Promise<string> {
		if (!(await this.app.vault.adapter.exists(base))) return base;
		const stem = base.replace(/\.conflictbak$/, "");
		for (let n = 2; n < 1000; n++) {
			// Literal `%` is already `%25`, so raw `%00` is an unambiguous,
			// variable-width collision marker that restore can remove exactly.
			const candidate = `${stem}%00${n}.conflictbak`;
			if (!(await this.app.vault.adapter.exists(candidate))) return candidate;
		}
		throw new DestinationOccupied(base);
	}

	private async ensureFolder(path: string): Promise<void> {
		// Neither create nor rename creates parent folders.
		if (!(await this.app.vault.adapter.exists(path))) {
			await this.app.vault.adapter.mkdir(path);
		}
	}
}
