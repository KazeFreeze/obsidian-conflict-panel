import type { ConflictGroup } from "./types";

export type EntryAction =
	| "keep-original"
	| "keep-copy"
	| "save-as-new"
	| "restore-copy"
	| "accept-deletion";

export interface EntryView {
	actions: EntryAction[];
	diffable: boolean;
	/** Shown before any action that has consequences beyond this device. */
	warning: string | null;
	explanation: string | null;
}

export function describeGroup(group: ConflictGroup): EntryView {
	switch (group.shape) {
		case "normal":
			return {
				actions: ["keep-original", "keep-copy", "save-as-new"],
				diffable: true,
				warning: null,
				explanation: null,
			};

		case "orphan":
			return {
				actions: ["restore-copy", "accept-deletion"],
				diffable: false,
				warning:
					"Restoring recreates a file another device deliberately deleted. Syncthing will propagate that to every device.",
				explanation: "The original no longer exists. Another device deleted it.",
			};

		case "opaque":
			return {
				actions: ["accept-deletion"],
				diffable: false,
				warning: null,
				explanation:
					"Not a Markdown file, so it cannot be compared or promoted. Copies can be moved to recovery.",
			};

		case "blocked":
			return {
				actions: [],
				diffable: false,
				warning: null,
				explanation: "A folder occupies this path, so the conflict cannot be resolved here.",
			};

		default:
			// An unrecognised shape must never reach a destructive action.
			return { actions: [], diffable: false, warning: null, explanation: null };
	}
}
