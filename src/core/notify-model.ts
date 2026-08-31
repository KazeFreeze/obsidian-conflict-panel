/**
 * The notice vocabulary, ported from Zync's plugin.
 *
 * Kept in `core/` and free of Obsidian imports so the kind -> icon and
 * kind -> duration rules are unit-testable. Zync learned this the hard way: the
 * sticky rule lived in two places, drifted, and the drift was invisible until
 * someone hit it on a device.
 */

/** Severity kind: drives the Lucide icon, the default duration, and the accent class. */
export type NotifyKind = "success" | "info" | "warning" | "error";

/** A one-tap action link inside a notice. Never auto-runs. */
export interface NotifyAction {
	label: string;
	run: () => void;
	/** If false, the notice stays open after the action runs (default: hide). */
	hideOnRun?: boolean;
}

export interface NotifyOptions {
	kind: NotifyKind;
	/** The word-first primary signal. Never a sentence. */
	title: string;
	detail?: string;
	action?: NotifyAction;
	/** Override the kind default. 0 = sticky. */
	durationMs?: number;
	/** Override the kind default, for a more specific signal. */
	icon?: string;
}

/** kind -> Lucide icon name. */
export const KIND_ICON: Record<NotifyKind, string> = {
	success: "check-circle",
	info: "info",
	warning: "alert-triangle",
	error: "x-circle",
};

/** kind -> default duration in ms. 0 = sticky. Problems stay until tapped. */
export const KIND_STICKY: Record<NotifyKind, number> = {
	success: 4000,
	info: 4000,
	warning: 0,
	error: 0,
};

export const noticeDuration = (opts: NotifyOptions): number =>
	opts.durationMs ?? KIND_STICKY[opts.kind];

/**
 * Should this notice interrupt a screen reader?
 *
 * The role follows the KIND, not the duration. `alert` is assertive and is right
 * for a problem, wrong for anything that merely lingers.
 */
export function noticeRole(opts: NotifyOptions): "alert" | "status" | null {
	if (opts.kind === "warning" || opts.kind === "error") return "alert";
	return noticeDuration(opts) === 0 ? "status" : null;
}

/** Shape -> the Lucide icon that labels a group in the list. */
export const SHAPE_ICON: Record<string, string> = {
	normal: "git-compare",
	orphan: "file-x",
	opaque: "file-question",
	blocked: "folder-x",
};
