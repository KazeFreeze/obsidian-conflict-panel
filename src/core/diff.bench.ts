import { bench, describe } from "vitest";
import { toHunks } from "./diff";

const hardLimitShape = (prefix: string, lineCount: number): string =>
	Array.from({ length: lineCount }, (_, index) =>
		`${prefix}-${index}`.padEnd(99, prefix === "left" ? "l" : "r"),
	).join("\n");

describe("toHunks near the accepted hard limit", () => {
	for (const lineCount of [900, 925, 935, 940, 945, 950, 1_000]) {
		const left = hardLimitShape("left", lineCount);
		const right = hardLimitShape("right", lineCount);
		bench(
			`${left.length.toLocaleString()} characters and ${lineCount.toLocaleString()} fully changed lines per side`,
			() => {
				toHunks(left, right, 100);
			},
			{ iterations: 8, warmupIterations: 3 },
		);
	}
});
