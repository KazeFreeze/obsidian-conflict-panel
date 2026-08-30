import { diffLines } from "diff";

export interface Hunk {
	/** Lines present only on the left (the kept file). */
	left: string[];
	/** Lines present only on the right (the conflict copy). */
	right: string[];
}

const DEFAULT_MAX_HUNKS = 500;

const lines = (value: string): string[] =>
	value.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));

/**
 * Line diff, capped. Android will kill the WebView if the main thread blocks long
 * enough, so a pathological diff must degrade rather than hang. Hitting the cap
 * means "too different to review here", which the UI states.
 */
export function toHunks(
	left: string,
	right: string,
	maxHunks: number = DEFAULT_MAX_HUNKS,
): Hunk[] {
	const hunks: Hunk[] = [];
	let pending: Hunk | null = null;

	for (const part of diffLines(left, right)) {
		if (!part.added && !part.removed) {
			if (pending) {
				hunks.push(pending);
				pending = null;
			}
			if (hunks.length >= maxHunks) return hunks;
			continue;
		}
		pending ??= { left: [], right: [] };
		if (part.removed) pending.left.push(...lines(part.value));
		if (part.added) pending.right.push(...lines(part.value));
	}

	if (pending) hunks.push(pending);
	return hunks.slice(0, maxHunks);
}
