import { App, normalizePath, PluginSettingTab, Setting } from "obsidian";
import type ConflictPanelPlugin from "./main";

export interface ConflictPanelSettings {
	/** Vault-relative folder that resolved conflict copies are moved into. */
	recoveryFolder: string;
}

export const DEFAULT_SETTINGS: ConflictPanelSettings = {
	recoveryFolder: "Conflict Recovery",
};

/** Canonicalize once where settings enter the application. */
export function normalizeRecoveryFolder(value: string): string {
	const canonical = normalizePath(value.trim())
		.split("/")
		.filter((segment) => segment && segment !== ".")
		.join("/");
	return canonical || DEFAULT_SETTINGS.recoveryFolder;
}

export class ConflictPanelSettingTab extends PluginSettingTab {
	plugin: ConflictPanelPlugin;

	constructor(app: App, plugin: ConflictPanelPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Recovery folder")
			.setDesc(
				"Resolved conflict copies are moved here. Nothing is ever deleted, so this folder grows until you empty it yourself.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Conflict Recovery")
					.setValue(this.plugin.settings.recoveryFolder)
					.onChange(async (value) => {
						this.plugin.settings.recoveryFolder = normalizeRecoveryFolder(value);
						await this.plugin.saveSettings();
					}),
			);
	}
}
