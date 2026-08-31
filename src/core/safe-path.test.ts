import { describe, expect, it } from "vitest";
import { isSafeVaultPath } from "./safe-path";

describe("isSafeVaultPath", () => {
	it.each(["note.md", "a/b/note.md", "Folder Name/note with spaces.md", "50%25 done.md"])(
		"accepts the ordinary vault path %j",
		(path) => expect(isSafeVaultPath(path)).toBe(true),
	);

	it.each([
		"../outside.md",
		"a/../../outside.md",
		"..",
		"/absolute.md",
		"a//b.md",
		"a/./b.md",
		"..\\outside.md",
		"\\absolute.md",
		"",
		"a/",
		"Recovery/",
	])("rejects %j", (path) => expect(isSafeVaultPath(path)).toBe(false));
});
