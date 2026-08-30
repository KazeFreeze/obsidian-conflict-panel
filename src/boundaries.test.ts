import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname);

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

	it("no module calls a deletion API anywhere", () => {
		// The defining property of v0.1. Three of five audited plugins lost data,
		// every one of them in a delete call.
		for (const file of sources(SRC)) {
			const text = readFileSync(file, "utf8");
			expect(text).not.toMatch(/\.delete\s*\(/);
			expect(text).not.toMatch(/trashFile\s*\(/);
			expect(text).not.toMatch(/\.trash\s*\(/);
		}
	});

	it("only vault-ops mutates the vault", () => {
		for (const file of sources(SRC)) {
			if (file.endsWith("vault-ops.ts")) continue;
			const text = readFileSync(file, "utf8");
			expect(text).not.toMatch(/vault\.(process|rename|create|modify)\s*\(/);
		}
	});
});
