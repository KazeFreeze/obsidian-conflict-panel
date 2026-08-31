import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { isSafeVaultPath } from "./core/safe-path";
import { DestinationOccupied, UnsafePath, VaultOps } from "./vault-ops";

export const CONFLICT_RECOVERY_VIEW = "conflict-panel-recovery";

interface Artifact {
	path: string;
	sourcePath: string;
	bytes: number;
	/** False when the decoded path contains traversal or is not canonical. */
	safe: boolean;
}

export class ConflictRecoveryView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly ops: () => VaultOps,
		private readonly recoveryFolder: () => string,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CONFLICT_RECOVERY_VIEW;
	}

	getDisplayText(): string {
		return "Conflict recovery";
	}

	getIcon(): string {
		return "archive";
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	/** Unsupported archive extensions must be enumerated through the adapter. */
	private async listArtifacts(): Promise<Artifact[]> {
		const adapter = this.app.vault.adapter;
		const root = this.recoveryFolder();
		if (!(await adapter.exists(root))) return [];
		const found: Artifact[] = [];
		const walk = async (directory: string): Promise<void> => {
			const listing = await adapter.list(directory);
			for (const file of listing.files) {
				if (!file.endsWith(".conflictbak")) continue;
				const stat = await adapter.stat(file);
				const sourcePath = VaultOps.sourcePathFromRecovery(file);
				found.push({
					path: file,
					sourcePath,
					bytes: stat?.size ?? 0,
					safe: isSafeVaultPath(sourcePath),
				});
			}
			for (const subfolder of listing.folders) await walk(subfolder);
		};
		await walk(root);
		return found;
	}

	private async render(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("conflict-recovery");
		const artifacts = await this.listArtifacts();

		const total = artifacts.reduce((bytes, artifact) => bytes + artifact.bytes, 0);
		root.createEl("h4", {
			text: `${artifacts.length} recovered ${artifacts.length === 1 ? "file" : "files"}, ${Math.round(total / 1024)} KB`,
		});
		root.createEl("p", {
			text: "Nothing here is ever deleted automatically. Restoring copies a file back; the archive stays until you remove it yourself.",
		});

		for (const artifact of artifacts) {
			const item = root.createDiv({ cls: "conflict-panel__item" });
			item.createDiv({ text: artifact.sourcePath, cls: "conflict-panel__path" });
			if (!artifact.safe) {
				item.createDiv({
					text: `This archive does not name a canonical vault-relative path, so it cannot be copied back. The file itself is intact at ${artifact.path}.`,
					cls: "conflict-compare__warning",
				});
				continue;
			}
			if (!artifact.sourcePath.endsWith(".md")) {
				item.createDiv({
					text: `This is not a Markdown file, so Conflict Panel cannot safely copy it back. The binary archive is intact at ${artifact.path}.`,
					cls: "conflict-compare__warning",
				});
				continue;
			}
			item
				.createEl("button", { text: "Copy back to its original path" })
				.addEventListener("click", () => void this.restore(artifact));
		}
	}

	private async restore(artifact: Artifact): Promise<void> {
		try {
			// No editor guard is needed here: createNew only targets an empty path,
			// so there is no existing file at that path for an editor to have open.
			const content = await this.app.vault.adapter.read(artifact.path);
			await this.ops().createNew(artifact.sourcePath, content);
			new Notice(`Copied back to ${artifact.sourcePath}. The archive is still in recovery.`);
			await this.render();
		} catch (error) {
			if (error instanceof DestinationOccupied) {
				new Notice(`${artifact.sourcePath} already exists. Nothing was written.`);
			} else if (error instanceof UnsafePath) {
				new Notice(error.message);
			} else {
				new Notice(`Could not restore: ${String(error)}`);
			}
		}
	}
}
