import { parseConflictPath } from "./detect";
import type { ConflictGroup, ConflictShape, ParsedConflictFile } from "./types";

/** What the grouper needs to know about the vault. The shell supplies this. */
export interface VaultIndex {
	files: Set<string>;
	folders: Set<string>;
}

/**
 * Strip conflict suffixes until the name stops changing.
 *
 * NOTE: this is deterministic but not always correct. A note deliberately named
 * `x.sync-conflict-20260101-010101-AAA.md` is indistinguishable, by filename alone,
 * from a copy of `x.md`. No filename-only rule can tell them apart, which is why the
 * UI always shows which files were paired and offers a view-only escape.
 */
function resolveOriginal(path: string): string {
	let current = path;
	for (;;) {
		const parsed = parseConflictPath(current);
		if (!parsed) return current;
		current = parsed.parentPath;
	}
}

function shapeFor(originalPath: string, index: VaultIndex): ConflictShape {
	if (index.folders.has(originalPath)) return "blocked";
	if (!originalPath.endsWith(".md")) return "opaque";
	if (!index.files.has(originalPath)) return "orphan";
	return "normal";
}

export function groupConflicts(
	paths: string[],
	index: VaultIndex,
	recoveryFolder: string,
): ConflictGroup[] {
	const recoveryRoot = recoveryFolder
		.replace(/\/+/g, "/")
		.replace(/^\/+|\/+$/g, "");
	const prefix = `${recoveryRoot}/`;
	const byOriginal = new Map<string, ParsedConflictFile[]>();

	for (const path of paths) {
		// The recovery folder is excluded outright. The non-note extension is only
		// defence in depth; this exclusion is the real protection against the
		// plugin rediscovering its own artifacts.
		if (recoveryRoot && (path === recoveryRoot || path.startsWith(prefix))) continue;

		const parsed = parseConflictPath(path);
		if (!parsed) continue;

		const original = resolveOriginal(path);
		const list = byOriginal.get(original) ?? [];
		list.push({ ...parsed, path });
		byOriginal.set(original, list);
	}

	return [...byOriginal.entries()]
		.map(([originalPath, copies]) => ({
			originalPath,
			shape: shapeFor(originalPath, index),
			copies: copies.sort((a, b) =>
				`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`),
			),
		}))
		.sort((a, b) => a.originalPath.localeCompare(b.originalPath));
}
