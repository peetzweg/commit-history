import { describe, expect, it } from "vitest";
import { niceYearStep, pickYearTicks } from "#/lib/chart-ticks";

const years = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, k) => ({
		i: k,
		year: String(from + k),
	}));

describe("niceYearStep", () => {
	it("keeps every year when they all fit", () => {
		// 800px / (14px axis) fits well over 5 labels.
		expect(niceYearStep(4, 800, 14)).toBe(1);
	});

	it("climbs the nice ladder (1→2→5…) as the range outgrows the width", () => {
		// Gavin's ~17-year span on the cramped mobile axis (26px, ~776px plot).
		expect(niceYearStep(17, 776, 26)).toBe(2);
		// A far longer range forces a bigger, still-round step.
		expect(niceYearStep(60, 776, 26)).toBe(10);
	});

	it("never returns 0 or below 1", () => {
		expect(niceYearStep(100, 100, 40)).toBeGreaterThanOrEqual(1);
	});
});

describe("pickYearTicks", () => {
	it("returns short lists untouched", () => {
		const t = years(2024, 2025);
		expect(pickYearTicks(t, 776, 26)).toEqual(t);
	});

	it("thins a crowded mobile axis to round years only", () => {
		const kept = pickYearTicks(years(2009, 2026), 776, 26).map((t) => t.year);
		// step 2 → even years survive; the 2009 partial year drops.
		expect(kept).toEqual([
			"2010",
			"2012",
			"2014",
			"2016",
			"2018",
			"2020",
			"2022",
			"2024",
			"2026",
		]);
	});

	it("leaves a roomy desktop axis showing every year when it fits", () => {
		const kept = pickYearTicks(years(2021, 2026), 796, 16).map((t) => t.year);
		expect(kept).toEqual(["2021", "2022", "2023", "2024", "2025", "2026"]);
	});
});
