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
	const segments: string[] = [];
	for (const segment of normalizePath(value.trim()).split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			// Reject the whole setting instead of clamping an attempted vault escape.
			if (segments.length === 0) return DEFAULT_SETTINGS.recoveryFolder;
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return segments.join("/") || DEFAULT_SETTINGS.recoveryFolder;
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
