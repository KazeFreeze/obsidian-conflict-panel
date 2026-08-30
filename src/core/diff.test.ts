import { describe, expect, it } from "vitest";
import { toHunks } from "./diff";

describe("toHunks", () => {
	it("returns no hunks for identical text", () => {
		expect(toHunks("a\nb\n", "a\nb\n")).toEqual([]);
	});

	it("reports an added line", () => {
		const h = toHunks("a\n", "a\nb\n");
		expect(h).toHaveLength(1);
		expect(h[0]!.right).toEqual(["b"]);
		expect(h[0]!.left).toEqual([]);
	});

	it("reports a changed line as left and right together", () => {
		const h = toHunks("gym at 6\n", "dentist 3pm\n");
		expect(h[0]!.left).toEqual(["gym at 6"]);
		expect(h[0]!.right).toEqual(["dentist 3pm"]);
	});

	it("stops after the hunk cap so a pathological diff cannot block the UI thread", () => {
		const left = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n");
		const right = Array.from({ length: 5000 }, (_, i) => `r${i}`).join("\n");
		expect(toHunks(left, right, 100).length).toBeLessThanOrEqual(100);
	});
});
