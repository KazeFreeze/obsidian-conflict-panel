/**
 * Is this a path we are willing to write to?
 *
 * Reject rather than sanitise: this input can come from a filename on disk.
 * Rewriting it would create a file at a path the user did not request.
 */
export function isSafeVaultPath(path: string): boolean {
	if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
	return path
		.split("/")
		.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
