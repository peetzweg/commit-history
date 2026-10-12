import { describe, expect, it } from "vitest";
import {
	parseMonthlyRefreshJob,
	planMonthlyRefreshFollowUp,
} from "#/lib/monthly-refresh-queue";

const NOW = new Date("2026-11-01T04:10:00.000Z");
const plus = (ms: number) => new Date(NOW.getTime() + ms);

describe("planMonthlyRefreshFollowUp", () => {
	it("is done once a pass completes, even with failures left for the next scheduled day", () => {
		expect(
			planMonthlyRefreshFollowUp({ status: "completed" }, NOW, null),
		).toEqual({ next: "done" });
	});

	it("continues right away when a slice hits its runtime cap", () => {
		expect(
			planMonthlyRefreshFollowUp(
				{ status: "stopped", stopReason: "max_runtime" },
				NOW,
				null,
			),
		).toEqual({ next: "next_slice", at: plus(5_000) });
	});

	it("waits for the GitHub reset when the budget floor stopped the slice", () => {
		const resetAt = plus(20 * 60_000);
		expect(
			planMonthlyRefreshFollowUp(
				{ status: "stopped", stopReason: "rate_limit_floor" },
				NOW,
				resetAt,
			),
		).toEqual({ next: "after_reset", at: resetAt });
	});

	it("never schedules a reset wait in the past, and falls back when the budget is unreadable", () => {
		expect(
			planMonthlyRefreshFollowUp(
				{ status: "stopped", stopReason: "rate_limit_floor" },
				NOW,
				plus(-60_000),
			),
		).toEqual({ next: "after_reset", at: plus(30_000) });
		expect(
			planMonthlyRefreshFollowUp(
				{ status: "stopped", stopReason: "rate_limit_floor" },
				NOW,
				null,
			),
		).toEqual({ next: "after_reset", at: plus(15 * 60_000) });
	});

	it("retries shortly when the local CLI holds the lock", () => {
		expect(planMonthlyRefreshFollowUp({ status: "locked" }, NOW, null)).toEqual(
			{ next: "locked_retry", at: plus(60_000) },
		);
	});

	it("is done when it fired too early, since a later scheduled day covers it", () => {
		expect(
			planMonthlyRefreshFollowUp({ status: "too_early" }, NOW, null),
		).toEqual({ next: "done" });
	});
});

describe("parseMonthlyRefreshJob", () => {
	it("accepts the scheduled payload and a deliberate target month", () => {
		expect(parseMonthlyRefreshJob({ version: 1 })).toEqual({ version: 1 });
		expect(
			parseMonthlyRefreshJob({ version: 1, targetMonth: "2026-10-01" }),
		).toEqual({ version: 1, targetMonth: "2026-10-01" });
	});

	it("rejects unknown versions and malformed months", () => {
		expect(() => parseMonthlyRefreshJob({ version: 2 })).toThrow();
		expect(() =>
			parseMonthlyRefreshJob({ version: 1, targetMonth: "2026-10" }),
		).toThrow();
		expect(() => parseMonthlyRefreshJob(null)).toThrow();
	});
});
