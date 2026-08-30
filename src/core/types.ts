/** One parsed `*.sync-conflict-*` filename. Paths are vault-relative strings. */
export interface ParsedConflict {
	/** Path this copy conflicts with, after stripping ONE suffix. */
	parentPath: string;
	/** Syncthing's short device ID, NOT the friendly name. There is no mapping. */
	deviceId: string;
	/** YYYYMMDD as written in the filename. */
	date: string;
	/** HHMMSS as written in the filename. */
	time: string;
}

export type ConflictShape =
	/** Original exists, is `.md`. Diffable and resolvable. */
	| "normal"
	/** Original absent. Syncthing's edit-versus-delete. */
	| "orphan"
	/** Not `.md`. Listed and movable, never diffed or promoted. */
	| "opaque"
	/** Canonical path holds a folder. View-only. */
	| "blocked";

export interface ConflictGroup {
	/** The canonical path all copies resolve to. */
	originalPath: string;
	shape: ConflictShape;
	/** At least one. Sorted by date+time ascending. */
	copies: ParsedConflictFile[];
}

export interface ParsedConflictFile extends ParsedConflict {
	/** Full vault-relative path of the conflict copy itself. */
	path: string;
}
