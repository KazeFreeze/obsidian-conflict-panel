import { Plugin } from "obsidian";
import type { ConflictGroup } from "./core/types";
import { CONFLICT_PANEL_VIEW, ConflictPanelView } from "./panel-view";
import { scanConflicts } from "./scan";
import {
	ConflictPanelSettings,
	ConflictPanelSettingTab,
	DEFAULT_SETTINGS,
	normalizeRecoveryFolder,
} from "./settings";

export default class ConflictPanelPlugin extends Plugin {
	// Definite-assignment assertion: strict mode cannot see that onload() assigns
	// this, because the assignment is async and outside the constructor. Without
	// the `!` the build fails with TS2564. The official sample plugin does the same.
	settings!: ConflictPanelSettings;
	private groups: ConflictGroup[] = [];

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerView(
			CONFLICT_PANEL_VIEW,
			(leaf) =>
				new ConflictPanelView(
					leaf,
					(group) => void this.openCompareView(group),
					() => this.rescan(),
				),
		);
		this.addRibbonIcon("git-merge", "Show conflicts", () => void this.revealPanel());
		this.addCommand({
			id: "scan-conflicts",
			name: "Scan for sync conflicts",
			callback: () => void this.rescan(),
		});
		this.addSettingTab(new ConflictPanelSettingTab(this.app, this));
	}

	async rescan(): Promise<void> {
		this.groups = scanConflicts(this.app.vault, this.settings.recoveryFolder);
		for (const leaf of this.app.workspace.getLeavesOfType(CONFLICT_PANEL_VIEW)) {
			(leaf.view as ConflictPanelView).setGroups(this.groups);
		}
	}

	async revealPanel(): Promise<void> {
		const [existing] = this.app.workspace.getLeavesOfType(CONFLICT_PANEL_VIEW);
		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: CONFLICT_PANEL_VIEW, active: true });
		await this.rescan();
	}

	/** Task 6 replaces this staging method once the compare view exists. */
	async openCompareView(group: ConflictGroup): Promise<void> {
		void group;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ConflictPanelSettings>,
		);
		this.settings.recoveryFolder = normalizeRecoveryFolder(this.settings.recoveryFolder);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
