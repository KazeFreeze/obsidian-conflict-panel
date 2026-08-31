import { beforeEach, describe, expect, it, vi } from "vitest";

const { normalizePath } = vi.hoisted(() => ({
	normalizePath: vi.fn((value: string) =>
		value
			.trim()
			.replace(/\\/g, "/")
			.replace(/\/+/g, "/")
			.replace(/^\/+|\/+$/g, ""),
	),
}));

vi.mock("obsidian", () => ({
	App: class {},
	normalizePath,
	PluginSettingTab: class {
		containerEl = { empty: vi.fn() };
	},
	Setting: class {},
}));

import { normalizeRecoveryFolder } from "./settings";

describe("normalizeRecoveryFolder", () => {
	beforeEach(() => {
		normalizePath.mockClear();
	});

	it.each([
		[" /Archive//Conflicts/ ", "Archive/Conflicts"],
		["Archive/./Conflicts", "Archive/Conflicts"],
		["./Conflicts", "Conflicts"],
		["Conflicts/.", "Conflicts"],
		["a/./b/./c", "a/b/c"],
		["Archive\\Conflicts", "Archive/Conflicts"],
		["a/../b", "b"],
		["../Recovery", "Conflict Recovery"],
		["a/../../etc", "Conflict Recovery"],
		["..", "Conflict Recovery"],
		["Conflicts/..", "Conflict Recovery"],
	])("normalizes %j with Obsidian at the settings boundary", (input, expected) => {
		expect(normalizeRecoveryFolder(input)).toBe(expected);
		expect(normalizePath).toHaveBeenCalledWith(input.trim());
	});

	it("uses the default when normalization produces an empty path", () => {
		expect(normalizeRecoveryFolder(" ././ ")).toBe("Conflict Recovery");
	});
});
