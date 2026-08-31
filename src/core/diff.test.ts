import { describe, expect, it } from "vitest";
import { needsConfirmation, toHunks } from "./diff";

describe("toHunks", () => {
	it("returns no hunks for identical text", () => {
		expect(toHunks("a\nb\n", "a\nb\n")).toEqual({
			status: "ok",
			hunks: [],
		});
	});

	it("reports an added line", () => {
		const result = toHunks("a\n", "a\nb\n");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const h = result.hunks;
		expect(h).toHaveLength(1);
		expect(h[0]!.right).toEqual(["b"]);
		expect(h[0]!.left).toEqual([]);
	});

	it("reports a changed line as left and right together", () => {
		const result = toHunks("gym at 6\n", "dentist 3pm\n");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const h = result.hunks;
		expect(h[0]!.left).toEqual(["gym at 6"]);
		expect(h[0]!.right).toEqual(["dentist 3pm"]);
	});

	it("rejects pathological input before diffing in well under a second", () => {
		const left = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n");
		const right = Array.from({ length: 5000 }, (_, i) => `r${i}`).join("\n");
		const started = performance.now();

		expect(toHunks(left, right, 100)).toEqual({ status: "too-large" });
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("completes accepted worst-case blocking work within 500ms", () => {
		const left = Array.from({ length: 1000 }, (_, i) => `left-${i}`).join("\n");
		const right = Array.from({ length: 1000 }, (_, i) => `right-${i}`).join("\n");
		const started = performance.now();

		expect(toHunks(left, right, 100).status).toBe("ok");
		// Measured worst case is about 180ms today; 500ms leaves CI headroom while
		// making a meaningful regression visible.
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("accepts exactly 1,000 newline-terminated lines", () => {
		const input = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join("\n") + "\n";

		expect(toHunks(input, input).status).toBe("ok");
	});

	it("rejects 1,001 newline-terminated lines", () => {
		const input = Array.from({ length: 1001 }, (_, i) => `line-${i}`).join("\n") + "\n";

		expect(toHunks(input, input)).toEqual({ status: "too-large" });
	});
});

describe("needsConfirmation", () => {
	it("lets small input compare without asking", () => {
		expect(needsConfirmation("a\nb", "a\nc")).toBe(false);
	});

	it("asks before comparing input past the soft character band", () => {
		expect(needsConfirmation("x".repeat(25_001), "y")).toBe(true);
	});

	it("asks before comparing newline-terminated input past the soft line band", () => {
		expect(needsConfirmation("x\n".repeat(251), "y")).toBe(true);
	});

	it("asks before comparing non-terminated input past the soft line band", () => {
		expect(needsConfirmation(Array.from({ length: 251 }, () => "x").join("\n"), "y")).toBe(
			true,
		);
	});

	it("asks when only the right side is large", () => {
		expect(needsConfirmation("y", "x".repeat(25_001))).toBe(true);
	});

	it("does not ask exactly at the band", () => {
		expect(needsConfirmation("x".repeat(25_000), "y")).toBe(false);
	});
});
