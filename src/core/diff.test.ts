import { describe, expect, it } from "vitest";
import { toHunks } from "./diff";

describe("toHunks", () => {
	it("returns no hunks for identical text", async () => {
		expect(await toHunks("a\nb\n", "a\nb\n")).toEqual({
			status: "ok",
			hunks: [],
		});
	});

	it("reports an added line", async () => {
		const result = await toHunks("a\n", "a\nb\n");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const h = result.hunks;
		expect(h).toHaveLength(1);
		expect(h[0]!.right).toEqual(["b"]);
		expect(h[0]!.left).toEqual([]);
	});

	it("reports a changed line as left and right together", async () => {
		const result = await toHunks("gym at 6\n", "dentist 3pm\n");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const h = result.hunks;
		expect(h[0]!.left).toEqual(["gym at 6"]);
		expect(h[0]!.right).toEqual(["dentist 3pm"]);
	});

	it("rejects pathological input before diffing in well under a second", async () => {
		const left = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n");
		const right = Array.from({ length: 5000 }, (_, i) => `r${i}`).join("\n");
		const started = performance.now();

		expect(await toHunks(left, right, 100)).toEqual({ status: "too-large" });
		expect(performance.now() - started).toBeLessThan(250);
	});
});
