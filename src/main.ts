import { Plugin } from "obsidian";
import { CONFLICT_COMPARE_VIEW, ConflictCompareView } from "./compare-view";
import type { ConflictGroup } from "./core/types";
import { CONFLICT_PANEL_VIEW, ConflictPanelView } from "./panel-view";
import { scanConflicts } from "./scan";
import {
	ConflictPanelSettings,
	ConflictPanelSettingTab,
	DEFAULT_SETTINGS,
	normalizeRecoveryFolder,
} from "./settings";
import { VaultOps } from "./vault-ops";

export default class ConflictPanelPlugin extends Plugin {
	// Definite-assignment assertion: strict mode cannot see that onload() assigns
	// this, because the assignment is async and outside the constructor. Without
	// the `!` the build fails with TS2564. The official sample plugin does the same.
	settings!: ConflictPanelSettings;
	private groups: ConflictGroup[] = [];
	private ops!: VaultOps;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.rebuildOps();
		this.registerView(
			CONFLICT_PANEL_VIEW,
			(leaf) =>
				new ConflictPanelView(
					leaf,
					(group) => void this.openCompareView(group),
					() => this.rescan(),
				),
		);
		this.registerView(
			CONFLICT_COMPARE_VIEW,
			(leaf) => new ConflictCompareView(leaf, () => this.ops, () => this.rescan()),
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

	async openCompareView(group: ConflictGroup): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: CONFLICT_COMPARE_VIEW, active: true });
		if (leaf.view instanceof ConflictCompareView) {
			await leaf.view.setGroup(group);
		}
	}

	private rebuildOps(): void {
		this.ops = new VaultOps(this.app, this.settings.recoveryFolder);
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
		this.rebuildOps();
		await this.rescan();
	}
}
