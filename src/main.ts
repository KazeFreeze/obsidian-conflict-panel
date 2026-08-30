import { Plugin } from "obsidian";
import {
	ConflictPanelSettings,
	ConflictPanelSettingTab,
	DEFAULT_SETTINGS,
} from "./settings";

export default class ConflictPanelPlugin extends Plugin {
	settings: ConflictPanelSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new ConflictPanelSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
