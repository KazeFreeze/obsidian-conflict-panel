import { TFile, TFolder, type Vault } from "obsidian";
import { groupConflicts } from "./core/group";
import type { ConflictGroup } from "./core/types";

/**
 * Build the index `groupConflicts` needs.
 *
 * Uses `getAllLoadedFiles` rather than `getFiles` because the grouper must know
 * about FOLDERS too: a folder occupying a canonical path is its own shape, and
 * `getFiles` would report that path as simply absent.
 */
export function buildVaultIndex(vault: Vault): { files: Set<string>; folders: Set<string> } {
	const files = new Set<string>();
	const folders = new Set<string>();
	for (const entry of vault.getAllLoadedFiles()) {
		if (entry instanceof TFolder) folders.add(entry.path);
		else if (entry instanceof TFile) files.add(entry.path);
	}
	return { files, folders };
}

export function scanConflicts(vault: Vault, recoveryFolder: string): ConflictGroup[] {
	const index = buildVaultIndex(vault);
	return groupConflicts([...index.files], index, recoveryFolder);
}
