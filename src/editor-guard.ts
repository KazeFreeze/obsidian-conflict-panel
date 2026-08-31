import type { Workspace } from "obsidian";
import type { ConflictGroup } from "./core/types";

/**
 * Every path currently open in a leaf.
 *
 * Reads TWO sources, and needs both.
 *
 * Since Obsidian 1.7.2 a background tab is DEFERRED: its `view` is a DeferredView
 * with no `file` at all. Reading only `view.file` therefore misses every note the
 * user is not currently looking at, which is precisely the dangerous case — a
 * pending autosave in a background tab is what overwrites the result. The
 * persisted view state still names the file, deferred or not.
 *
 * `iterateAllLeaves` covers sidebar and pop-out leaves, which `activeEditor` does
 * not. This still cannot see editors embedded by other plugins or a Markdown file
 * inside a Canvas card, and cannot stop a note being opened during an awaited
 * operation. A narrowing, not a guarantee.
 */
export function openPathsIn(workspace: Workspace): Set<string> {
	const open = new Set<string>();
	workspace.iterateAllLeaves((leaf) => {
		const file = (leaf.view as { file?: { path: string } }).file;
		if (file?.path) open.add(file.path);
		const stateFile = (leaf.getViewState().state as { file?: unknown } | undefined)?.file;
		if (typeof stateFile === "string" && stateFile) open.add(stateFile);
	});
	return open;
}

/** Which files of this group are open, if any. Empty means safe to proceed. */
export function blockingPaths(group: ConflictGroup, open: Set<string>): string[] {
	const candidates = [group.originalPath, ...group.copies.map((copy) => copy.path)];
	return candidates.filter((path) => open.has(path));
}
