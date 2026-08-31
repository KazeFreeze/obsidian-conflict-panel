import type { Workspace } from "obsidian";
import type { ConflictGroup } from "./core/types";

/**
 * Every path currently open in a leaf.
 *
 * `iterateAllLeaves` covers sidebar and pop-out leaves, which `activeEditor` does
 * not. This cannot see editors embedded by other plugins, and cannot stop a note
 * being opened during an awaited operation — a narrowing, not a guarantee.
 */
export function openPathsIn(workspace: Workspace): Set<string> {
	const open = new Set<string>();
	workspace.iterateAllLeaves((leaf) => {
		const file = (leaf.view as { file?: { path: string } }).file;
		if (file?.path) open.add(file.path);
	});
	return open;
}

/** Which files of this group are open, if any. Empty means safe to proceed. */
export function blockingPaths(group: ConflictGroup, open: Set<string>): string[] {
	const candidates = [group.originalPath, ...group.copies.map((copy) => copy.path)];
	return candidates.filter((path) => open.has(path));
}
