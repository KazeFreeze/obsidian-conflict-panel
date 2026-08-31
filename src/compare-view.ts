import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { notifyError, notifyInfo, notifySuccess, notifyWarning } from "./notify";
import { needsConfirmation, toHunks, type DiffResult } from "./core/diff";
import { describeGroup, type EntryAction } from "./core/entry-view";
import type { ConflictGroup } from "./core/types";
import { blockingPaths, openPathsIn } from "./editor-guard";
import {
	DestinationOccupied,
	RestoreArchiveFailed,
	StaleInput,
	UnsafePath,
	VaultOps,
} from "./vault-ops";

export const CONFLICT_COMPARE_VIEW = "conflict-panel-compare";

export class ConflictCompareView extends ItemView {
	private group: ConflictGroup | null = null;
	private selectedCopy = 0;
	private reviewedOriginal: string | null = null;
	private reviewedCopy: string | null = null;
	private diff: DiffResult | null = null;
	private awaitingConfirmation = false;
	private loading = false;
	private busy = false;
	private loadToken = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly ops: () => VaultOps,
		private readonly afterResolve: () => Promise<void>,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CONFLICT_COMPARE_VIEW;
	}

	getDisplayText(): string {
		return this.group ? `Conflict: ${this.group.originalPath}` : "Conflict";
	}

	getIcon(): string {
		return "git-compare";
	}

	async setGroup(group: ConflictGroup): Promise<void> {
		this.group = group;
		this.selectedCopy = 0;
		await this.loadSelection();
		this.render();
	}

	/** Read into locals; only the latest selection token may publish state. */
	private async loadSelection(): Promise<void> {
		const token = ++this.loadToken;
		this.loading = true;
		const copy = this.copyFile();
		const original = this.originalFile();
		let copyText: string | null = null;
		let originalText: string | null = null;
		try {
			copyText = copy ? await this.app.vault.read(copy) : null;
			originalText = original ? await this.app.vault.read(original) : null;
		} catch (error) {
			// A copy Syncthing removed mid-read would otherwise leave `loading` set
			// forever: every action stays disabled and nothing on screen says why.
			if (token !== this.loadToken) return;
			this.reviewedCopy = null;
			this.reviewedOriginal = null;
			this.diff = null;
			this.awaitingConfirmation = false;
			this.loading = false;
			notifyError("Unreadable", `${String(error)} Rescan and try again.`);
			return;
		}
		if (token !== this.loadToken) return;

		this.reviewedCopy = copyText;
		this.reviewedOriginal = originalText;
		this.diff = null;
		this.awaitingConfirmation = false;
		this.loading = false;
		if (originalText === null || copyText === null) return;
		if (needsConfirmation(originalText, copyText)) this.awaitingConfirmation = true;
		else this.diff = toHunks(originalText, copyText);
	}

	/** The one deliberate blocking event-handler call, reached only by pressing the button. */
	private computeOnDemand(): void {
		if (this.busy) return;
		const left = this.reviewedOriginal;
		const right = this.reviewedCopy;
		if (left === null || right === null) return;
		this.awaitingConfirmation = false;
		this.diff = toHunks(left, right);
		this.render();
	}

	private originalFile(): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(this.group?.originalPath ?? "");
		return file instanceof TFile ? file : null;
	}

	private copyFile(): TFile | null {
		const path = this.group?.copies[this.selectedCopy]?.path;
		if (!path) return null;
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("conflict-compare");
		const group = this.group;
		if (!group) return;
		const view = describeGroup(group);

		root.createEl("h3", { text: group.originalPath });
		if (view.explanation) {
			root.createEl("p", { text: view.explanation, cls: "conflict-compare__explanation" });
		}
		if (view.warning) {
			root.createEl("p", { text: view.warning, cls: "conflict-compare__warning" });
		}

		this.renderCopyPicker(root, group);
		if (view.diffable) this.renderDiff(root);
		this.renderActions(root, view.actions);
	}

	private renderCopyPicker(root: HTMLElement, group: ConflictGroup): void {
		if (group.copies.length < 2) return;
		const picker = root.createDiv({ cls: "conflict-compare__copies" });
		group.copies.forEach((copy, index) => {
			const label = `device ${copy.deviceId}, ${copy.time.slice(0, 2)}:${copy.time.slice(2, 4)}`;
			const button = picker.createEl("button", { text: label });
			if (index === this.selectedCopy) button.addClass("is-selected");
			button.addEventListener("click", () => {
				if (this.busy) return;
				this.selectedCopy = index;
				// Invalidate the old selection synchronously. Until the new reads land,
				// no action may pair this selection with the previous copy's text.
				this.reviewedOriginal = null;
				this.reviewedCopy = null;
				this.diff = null;
				this.awaitingConfirmation = false;
				this.loading = true;
				this.render();
				void this.loadSelection().then(() => this.render());
			});
		});
	}

	/** Render stored diff state only. */
	private renderDiff(root: HTMLElement): void {
		const box = root.createDiv({ cls: "conflict-compare__diff" });
		if (this.awaitingConfirmation) {
			box.createEl("p", {
				text: "These files are large. Comparing them will freeze Obsidian for up to half a second.",
			});
			box.createEl("button", { text: "Compare anyway" }).addEventListener("click", () =>
				this.computeOnDemand(),
			);
			return;
		}

		const result = this.diff;
		if (result === null) return;
		if (result.status === "too-large") {
			box.createEl("p", {
				text: "These files are too large to compare here. Open them side by side instead.",
			});
			return;
		}
		if (result.hunks.length === 0) {
			box.createEl("p", { text: "The two files have identical text." });
			return;
		}
		for (const hunk of result.hunks) {
			const element = box.createDiv({ cls: "conflict-compare__hunk" });
			// A "-"/"+" gutter, not colour alone. The tint is a hint; the marker is
			// what makes a hunk readable at low contrast or with colour vision loss.
			for (const line of hunk.left) this.renderLine(element, "-", line, "is-left");
			for (const line of hunk.right) this.renderLine(element, "+", line, "is-right");
		}
	}

	private renderLine(parent: HTMLElement, marker: string, text: string, cls: string): void {
		const row = parent.createDiv({ cls: `conflict-compare__line ${cls}` });
		row.createSpan({ cls: "conflict-compare__marker", text: marker });
		row.createSpan({ cls: "conflict-compare__text", text });
	}

	private renderActions(root: HTMLElement, actions: readonly EntryAction[]): void {
		if (actions.length === 0) return;
		const bar = root.createDiv({ cls: "conflict-compare__actions" });
		const labels: Record<EntryAction, string> = {
			"keep-original": "Keep the original",
			"keep-copy": "Keep this copy",
			"save-as-new": "Save this copy as a new note",
			"restore-copy": "Restore this copy",
			"accept-deletion": "Move copies to recovery",
		};
		for (const action of actions) {
			const button = bar.createEl("button", { text: labels[action] });
			button.disabled = this.loading;
			button.addEventListener("click", () => void this.run(action));
		}
	}

	private async run(action: EntryAction): Promise<void> {
		const group = this.group;
		if (!group) return;
		if (this.loading) {
			notifyInfo("Loading", "Wait for the selected copy to finish reading.");
			return;
		}
		if (this.busy) return;
		const blocked = blockingPaths(group, openPathsIn(this.app.workspace));
		if (blocked.length > 0) {
			notifyWarning(
				"Close it first",
				`${blocked.join(", ")} is open. A pending editor save could overwrite the result.`,
			);
			return;
		}

		this.busy = true;
		try {
			const resolved = await this.dispatch(action);
			await this.afterResolve();
			if (resolved) this.leaf.detach();
		} catch (error) {
			this.report(error);
		} finally {
			this.busy = false;
		}
	}

	private allCopyFiles(): TFile[] {
		return (this.group?.copies ?? [])
			.map((copy) => this.app.vault.getAbstractFileByPath(copy.path))
			.filter((file): file is TFile => file instanceof TFile);
	}

	private async archiveAll(files: TFile[]): Promise<void> {
		const results = await this.ops().moveAllToRecovery(files);
		const failed = results.filter((result) => result.status === "failed").length;
		const expected = this.group?.copies.length ?? files.length;
		const disappeared = Math.max(0, expected - files.length);
		const missingNotice = this.disappearedNotice(disappeared);
		// Word-first title, detail underneath. A partial failure is a WARNING and
		// therefore sticky: it names files the user still has to deal with by hand.
		if (failed === 0) {
			notifySuccess("Resolved", `Moved ${results.length} to recovery.${missingNotice}`);
		} else {
			notifyWarning(
				"Partly moved",
				`Moved ${results.length - failed}, ${failed} failed. Nothing was deleted.${missingNotice}`,
			);
		}
	}

	private disappearedNotice(count: number): string {
		if (count === 0) return "";
		return ` ${count} scanned ${count === 1 ? "copy was" : "copies were"} no longer present and could not be moved.`;
	}

	private async dispatch(action: EntryAction): Promise<boolean> {
		const group = this.group;
		if (!group) return false;
		const copy = this.copyFile();
		const original = this.originalFile();

		if (action === "keep-original" || action === "accept-deletion") {
			await this.archiveAll(this.allCopyFiles());
			return true;
		}
		if (action === "keep-copy") {
			if (!original || !copy || this.reviewedOriginal === null || this.reviewedCopy === null) {
				return false;
			}
			await this.ops().replaceOriginal(original, this.reviewedOriginal, this.reviewedCopy);
			await this.archiveAll(this.allCopyFiles());
			notifySuccess("Kept this copy", `${group.originalPath} now holds the selected copy.`);
			return true;
		}
		if (action === "restore-copy") {
			if (!copy) return false;
			let selectedArchiveFailed = false;
			try {
				await this.ops().restoreTo(copy, group.originalPath);
			} catch (error) {
				if (!(error instanceof RestoreArchiveFailed)) throw error;
				selectedArchiveFailed = true;
			}

			const remaining = this.allCopyFiles().filter((file) => file.path !== copy.path);
			const results = await this.ops().moveAllToRecovery(remaining);
			const remainingFailed = results.filter((result) => result.status === "failed").length;
			const failed = remainingFailed + (selectedArchiveFailed ? 1 : 0);
			const moved = results.length - remainingFailed + (selectedArchiveFailed ? 0 : 1);
			const disappeared = Math.max(0, group.copies.length - 1 - remaining.length);
			const missingNotice = this.disappearedNotice(disappeared);
			if (failed === 0) {
				notifySuccess("Restored", `${group.originalPath}. Moved ${moved} to recovery.${missingNotice}`);
			} else {
				notifyWarning(
					"Restored, partly moved",
					`${group.originalPath} is back. ${failed} could not be moved to recovery. Nothing was deleted.${missingNotice}`,
				);
			}
			return true;
		}
		if (action === "save-as-new") {
			if (!copy || this.reviewedCopy === null) return false;
			const selected = group.copies[this.selectedCopy];
			if (!selected) return false;
			const target = `${group.originalPath.replace(/\.md$/, "")} (from ${selected.deviceId}).md`;
			await this.ops().createNew(target, this.reviewedCopy);
			// Info, not success: this resolves nothing and the group returns on the
			// next scan. Saying "saved" alone would read as done.
			notifyInfo("Saved a copy", `${target}. The conflict is still unresolved.`);
			return false;
		}
		return false;
	}

	private report(error: unknown): void {
		if (error instanceof StaleInput) {
			notifyWarning(
				"Changed while you looked",
				"Nothing was written. Rescan and try again.",
				{ label: "Rescan", run: () => void this.afterResolve() },
			);
		} else if (error instanceof RestoreArchiveFailed) {
			notifyWarning("Restored, not archived", error.message);
		} else if (error instanceof DestinationOccupied || error instanceof UnsafePath) {
			notifyWarning("Refused", error.message);
		} else {
			notifyError("Failed", String(error));
		}
	}
}
