import { Plugin } from "obsidian";
import { CONFLICT_COMPARE_VIEW, ConflictCompareView } from "./compare-view";
import type { ConflictGroup } from "./core/types";
import { CONFLICT_PANEL_VIEW, ConflictPanelView } from "./panel-view";
import { CONFLICT_RECOVERY_VIEW, ConflictRecoveryView } from "./recovery-view";
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
		this.registerView(
			CONFLICT_RECOVERY_VIEW,
			(leaf) =>
				new ConflictRecoveryView(
					leaf,
					() => this.ops,
					() => this.settings.recoveryFolder,
				),
		);
		this.addRibbonIcon("git-merge", "Show conflicts", () => void this.revealPanel());
		this.addCommand({
			id: "scan-conflicts",
			name: "Scan for sync conflicts",
			callback: () => void this.rescan(),
		});
		this.addCommand({
			id: "open-recovery",
			name: "Open conflict recovery",
			callback: () => void this.openRecovery(),
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
		// revealLeaf, not setActiveLeaf: only revealLeaf UNCOLLAPSES the sidebar the
		// leaf lives in. With a collapsed right sidebar, which is the default, the
		// ribbon icon otherwise creates the view and shows the user nothing at all.
		// Awaiting it also guarantees the view is loaded rather than deferred.
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			await this.rescan();
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: CONFLICT_PANEL_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
		await this.rescan();
	}

	async openCompareView(group: ConflictGroup): Promise<void> {
		// Reuse the open compare tab instead of stacking one per click. Four tabs all
		// titled "Conflict" is what happens otherwise, and none of them says which.
		const [existing] = this.app.workspace.getLeavesOfType(CONFLICT_COMPARE_VIEW);
		const leaf = existing ?? this.app.workspace.getLeaf(true);
		if (!existing) await leaf.setViewState({ type: CONFLICT_COMPARE_VIEW, active: true });
		// Since 1.7.2 setViewState can leave a DEFERRED view, so leaf.view is not yet
		// a ConflictCompareView and the instanceof below would silently skip
		// setGroup, opening a blank tab. revealLeaf awaits the real view.
		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof ConflictCompareView) {
			await leaf.view.setGroup(group);
		}
	}

	async openRecovery(): Promise<void> {
		const [existing] = this.app.workspace.getLeavesOfType(CONFLICT_RECOVERY_VIEW);
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: CONFLICT_RECOVERY_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
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
