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

	// No wall-clock assertion lives here any more.
	//
	// There used to be two, at 250ms and 500ms. A reviewer running the suite in
	// parallel made the 500ms one fail, and a test that reddens under CPU
	// contention teaches you to disbelieve red runs, which is worse than having no
	// timing test at all. Cost belongs in src/core/diff.bench.ts, which measures
	// this exact hard-corner shape and is what set the 94,500-character band.
	//
	// What is asserted here instead is the CONTRACT that keeps the cost bounded:
	// pathological input is rejected before jsdiff ever runs.

	it("rejects pathological input without diffing it", () => {
		const left = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n");
		const right = Array.from({ length: 5000 }, (_, i) => `r${i}`).join("\n");

		expect(toHunks(left, right, 100)).toEqual({ status: "too-large" });
	});

	it("accepts the worst case it is willing to run", () => {
		const left = Array.from({ length: 1000 }, (_, i) => `left-${i}`.padEnd(99, "l")).join(
			"\n",
		);
		const right = Array.from({ length: 1000 }, (_, i) => `right-${i}`.padEnd(99, "r")).join(
			"\n",
		);

		expect(toHunks(left, right, 100).status).toBe("ok");
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
		expect(needsConfirmation("x".repeat(94_501), "y")).toBe(true);
	});

	it("asks before comparing newline-terminated input past the soft line band", () => {
		expect(needsConfirmation("x\n".repeat(946), "y")).toBe(true);
	});

	it("asks before comparing non-terminated input past the soft line band", () => {
		expect(needsConfirmation(Array.from({ length: 946 }, () => "x").join("\n"), "y")).toBe(
			true,
		);
	});

	it("asks when only the right side is large", () => {
		expect(needsConfirmation("y", "x".repeat(94_501))).toBe(true);
	});

	it("asks when the right side is past the LINE band but short", () => {
		// Kills a right-side check that only measures characters: 946 short lines is
		// far under the character band and still expensive to diff.
		expect(needsConfirmation("y", "x\n".repeat(946))).toBe(true);
	});

	it("does not ask exactly at the band", () => {
		expect(needsConfirmation("x".repeat(94_500), "y")).toBe(false);
	});
});
