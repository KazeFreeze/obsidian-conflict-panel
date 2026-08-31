import { describe, expect, it } from "vitest";
import { KIND_ICON, noticeDuration, noticeRole, SHAPE_ICON } from "./notify-model";

describe("notice duration", () => {
	it("keeps a problem on screen until it is tapped", () => {
		expect(noticeDuration({ kind: "warning", title: "x" })).toBe(0);
		expect(noticeDuration({ kind: "error", title: "x" })).toBe(0);
	});

	it("auto-dismisses anything that is not a problem", () => {
		expect(noticeDuration({ kind: "success", title: "x" })).toBe(4000);
		expect(noticeDuration({ kind: "info", title: "x" })).toBe(4000);
	});

	it("lets a caller override the kind default", () => {
		expect(noticeDuration({ kind: "error", title: "x", durationMs: 500 })).toBe(500);
	});
});

describe("notice role", () => {
	it("interrupts for a problem, whatever its duration", () => {
		expect(noticeRole({ kind: "error", title: "x", durationMs: 500 })).toBe("alert");
		expect(noticeRole({ kind: "warning", title: "x" })).toBe("alert");
	});

	it("is polite for a sticky that is not a problem", () => {
		expect(noticeRole({ kind: "info", title: "x", durationMs: 0 })).toBe("status");
	});

	it("says nothing for an ordinary auto-dismissing notice", () => {
		expect(noticeRole({ kind: "success", title: "x" })).toBeNull();
	});
});

describe("icons", () => {
	it("gives every kind and every shape a Lucide name", () => {
		for (const name of Object.values(KIND_ICON)) expect(name).toMatch(/^[a-z-]+$/);
		for (const shape of ["normal", "orphan", "opaque", "blocked"]) {
			expect(SHAPE_ICON[shape]).toMatch(/^[a-z-]+$/);
		}
	});
});
