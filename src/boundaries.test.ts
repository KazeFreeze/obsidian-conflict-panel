import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname);

const DELETION_API_SPELLINGS = [
	/(?:\.(?:delete|trash|trashFile)|\[\s*["'](?:delete|trash|trashFile)["']\s*\])\s*(?:\?\.)?\s*(?:\(|\.bind\s*\()/,
];

const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? sources(join(dir, e.name))
			: e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
				? [join(dir, e.name)]
				: [],
	);

describe("boundaries", () => {
	it("core/ never imports obsidian, so it stays unit-testable", () => {
		for (const file of sources(join(SRC, "core"))) {
			expect(readFileSync(file, "utf8")).not.toMatch(/from ["']obsidian["']/);
		}
	});

	it("source has no common literal deletion API spellings", () => {
		// This is a spelling guard, not proof: it can false-positive in comments and
		// cannot recognise every alias or dynamically computed property.
		for (const file of sources(SRC)) {
			const text = readFileSync(file, "utf8");
			for (const spelling of DELETION_API_SPELLINGS) {
				expect(text).not.toMatch(spelling);
			}
		}
	});

	it("source has no common literal vault-mutation spellings outside vault-ops", () => {
		for (const file of sources(SRC)) {
			if (file.endsWith("vault-ops.ts")) continue;
			const text = readFileSync(file, "utf8");
			expect(text).not.toMatch(/vault\.(process|rename|create|modify)\s*\(/);
		}
	});

	it.each([
		"const remove = app.vault.delete.bind(app.vault);",
		'await app.vault["delete"](file);',
		"await vault.delete?.(file);",
		"await app.vault.trash(file);",
		"await fileManager.trashFile(file);",
	])("recognises deletion spelling in %j", (source) => {
		expect(DELETION_API_SPELLINGS.some((pattern) => pattern.test(source))).toBe(true);
	});
});
