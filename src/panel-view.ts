import { ItemView, WorkspaceLeaf } from "obsidian";
import { describeGroup } from "./core/entry-view";
import type { ConflictGroup } from "./core/types";

export const CONFLICT_PANEL_VIEW = "conflict-panel-list";

export class ConflictPanelView extends ItemView {
	private groups: ConflictGroup[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private readonly onOpenGroup: (group: ConflictGroup) => void,
		private readonly onRescan: () => Promise<void>,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CONFLICT_PANEL_VIEW;
	}

	getDisplayText(): string {
		return "Conflicts";
	}

	getIcon(): string {
		return "git-merge";
	}

	setGroups(groups: ConflictGroup[]): void {
		this.groups = groups;
		this.render();
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("conflict-panel");

		const header = root.createDiv({ cls: "conflict-panel__header" });
		header.createEl("h4", {
			text: this.groups.length === 1 ? "1 conflict" : `${this.groups.length} conflicts`,
		});
		header
			.createEl("button", { text: "Rescan", cls: "conflict-panel__rescan" })
			.addEventListener("click", () => void this.onRescan());

		if (this.groups.length === 0) {
			root.createEl("p", {
				text: "No conflict files found.",
				cls: "conflict-panel__empty",
			});
			return;
		}

		const list = root.createEl("ul", { cls: "conflict-panel__list" });
		for (const group of this.groups) {
			const view = describeGroup(group);
			const item = list.createEl("li", { cls: "conflict-panel__item" });
			const button = item.createEl("button", { cls: "conflict-panel__entry" });
			button.createSpan({ text: group.originalPath, cls: "conflict-panel__path" });
			button.createSpan({
				text: group.copies.length === 1 ? "1 copy" : `${group.copies.length} copies`,
				cls: "conflict-panel__meta",
			});
			if (view.explanation) {
				button.createSpan({ text: view.explanation, cls: "conflict-panel__note" });
			}
			button.addEventListener("click", () => this.onOpenGroup(group));
		}
	}
}
