import type { ParsedConflict } from "./types";

/**
 * Syncthing's conflict format: `<base>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<deviceId><ext>`
 *
 * The base group is GREEDY on purpose. A copy-of-a-copy carries several suffixes,
 * and greedy matching strips the RIGHTMOST one, which is the most recent. Callers
 * recurse to reach the true original.
 */
const CONFLICT_RE =
	/^(?<base>.+)\.sync-conflict-(?<date>\d{8})-(?<time>\d{6})-(?<device>[A-Z0-9]+)(?<ext>\.[^.]+)?$/;

export function parseConflictPath(path: string): ParsedConflict | null {
	const slash = path.lastIndexOf("/");
	const dir = slash === -1 ? "" : path.slice(0, slash + 1);
	const name = slash === -1 ? path : path.slice(slash + 1);

	const m = CONFLICT_RE.exec(name);
	if (!m?.groups) return null;

	const { base, date, time, device, ext } = m.groups;
	if (!base || !date || !time || !device) return null;
	return {
		parentPath: `${dir}${base}${ext ?? ""}`,
		deviceId: device,
		date,
		time,
	};
}
