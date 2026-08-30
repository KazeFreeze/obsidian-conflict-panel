import { Plugin } from "obsidian";
import {
	ConflictPanelSettings,
	ConflictPanelSettingTab,
	DEFAULT_SETTINGS,
} from "./settings";

export default class ConflictPanelPlugin extends Plugin {
	// Definite-assignment assertion: strict mode cannot see that onload() assigns
	// this, because the assignment is async and outside the constructor. Without
	// the `!` the build fails with TS2564. The official sample plugin does the same.
	settings!: ConflictPanelSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new ConflictPanelSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ConflictPanelSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
