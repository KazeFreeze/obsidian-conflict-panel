import { diffLines } from "diff";

export interface Hunk {
	/** Lines present only on the left (the kept file). */
	left: string[];
	/** Lines present only on the right (the conflict copy). */
	right: string[];
}

export type DiffResult =
	| { status: "ok"; hunks: Hunk[] }
	| { status: "too-large" };

const DEFAULT_MAX_HUNKS = 500;
// These limits bound jsdiff's worst-case work while still covering ordinary notes.
// String length is UTF-16 code units, available in O(1); line counting exits early.
const MAX_INPUT_CHARS = 100_000;
const MAX_INPUT_LINES = 1_000;

// The committed benchmark uses fully changed 99-character lines. On 2026-08-31,
// 94,499 chars / 945 lines averaged 196ms and 94,999 / 950 averaged 219ms;
// the accepted hard corner averaged 266ms. Prompt beyond the last sub-200ms case.
const SOFT_INPUT_CHARS = 94_500;
const SOFT_INPUT_LINES = 945;

const lines = (value: string): string[] =>
	value.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));

const pastSoftBand = (value: string): boolean => {
	if (value.length > SOFT_INPUT_CHARS) return true;
	// Match toHunks: a trailing newline does not create a displayed empty line.
	let lineCount = value.length === 0 ? 0 : 1;
	for (let i = 0; i < value.length - 1; i++) {
		if (value.charCodeAt(i) === 10 && ++lineCount > SOFT_INPUT_LINES) return true;
	}
	return false;
};

/** Should the view make the user press a button before synchronous diffing? */
export function needsConfirmation(left: string, right: string): boolean {
	return pastSoftBand(left) || pastSoftBand(right);
}

function inputTooLarge(value: string): boolean {
	if (value.length > MAX_INPUT_CHARS) return true;
	// Match lines(): a trailing newline does not create a displayed empty line.
	let lineCount = value.length === 0 ? 0 : 1;
	for (let i = 0; i < value.length - 1; i++) {
		if (value.charCodeAt(i) === 10 && ++lineCount > MAX_INPUT_LINES) return true;
	}
	return false;
}

/**
 * Synchronous line diff with bounded input and output. Oversized input is rejected
 * before jsdiff sees it, but accepted work is blocking: jsdiff does not expose a
 * chunked API. The UI maps `too-large` to "too large to compare here".
 */
export function toHunks(
	left: string,
	right: string,
	maxHunks: number = DEFAULT_MAX_HUNKS,
): DiffResult {
	if (inputTooLarge(left) || inputTooLarge(right)) return { status: "too-large" };

	const hunks: Hunk[] = [];
	let pending: Hunk | null = null;

	for (const part of diffLines(left, right)) {
		if (!part.added && !part.removed) {
			if (pending) {
				hunks.push(pending);
				pending = null;
			}
			if (hunks.length >= maxHunks) return { status: "ok", hunks };
			continue;
		}
		pending ??= { left: [], right: [] };
		if (part.removed) pending.left.push(...lines(part.value));
		if (part.added) pending.right.push(...lines(part.value));
	}

	if (pending) hunks.push(pending);
	return { status: "ok", hunks: hunks.slice(0, maxHunks) };
}
