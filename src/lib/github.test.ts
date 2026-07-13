import { describe, expect, it } from "vitest";
import { isValidLogin, monthlyWindows, yearlyWindows } from "#/lib/github";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe("isValidLogin", () => {
	it("accepts ordinary GitHub usernames", () => {
		for (const login of ["torvalds", "peetzweg", "gaearon", "a", "user-name"]) {
			expect(isValidLogin(login)).toBe(true);
		}
	});

	it("accepts legacy grandfathered usernames that violate current naming rules", () => {
		// Real accounts created before GitHub tightened username rules (~2013): trailing hyphen
		// and double hyphens. These must stay lookup-able — the previous regex rejected them.
		for (const login of ["Link-", "gil--", "p-", "-legacy"]) {
			expect(isValidLogin(login)).toBe(true);
		}
	});

	it("rejects empty, over-length, and injection-shaped input", () => {
		for (const login of [
			"",
			"a".repeat(40),
			'x") { id } __schema { types { name } } #',
			"foo bar",
			"foo/bar",
			'a"b',
		]) {
			expect(isValidLogin(login)).toBe(false);
		}
	});
});

describe("yearlyWindows", () => {
	const now = new Date("2026-07-08T12:34:56Z");

	it("excludes the in-progress month, like monthlyWindows", () => {
		const windows = yearlyWindows(new Date("2025-01-01T00:00:00Z"), now);
		const last = windows.at(-1);
		expect(last).toBeDefined();
		// Coverage ends 1s before the first instant of the current month.
		expect(last?.to).toBe("2026-06-30T23:59:59.000Z");
	});

	it("never exceeds GraphQL's one-year window cap", () => {
		const windows = yearlyWindows(new Date("2015-04-04T09:00:00Z"), now);
		for (const w of windows) {
			const span = new Date(w.to).getTime() - new Date(w.from).getTime();
			expect(span).toBeLessThanOrEqual(YEAR_MS);
		}
	});

	it("tiles the range without gaps or overlaps", () => {
		const windows = yearlyWindows(new Date("2015-04-04T09:00:00Z"), now);
		expect(windows.length).toBeGreaterThan(10);
		for (let i = 1; i < windows.length; i++) {
			const prevTo = new Date(windows[i - 1].to).getTime();
			const from = new Date(windows[i].from).getTime();
			// Same 1-second seam as monthlyWindows' month boundaries.
			expect(from - prevTo).toBe(1000);
		}
	});

	it("yields a single short window for accounts younger than a year", () => {
		const windows = yearlyWindows(new Date("2026-02-15T00:00:00Z"), now);
		expect(windows).toHaveLength(1);
		expect(windows[0].from).toBe("2026-02-15T00:00:00.000Z");
		expect(windows[0].to).toBe("2026-06-30T23:59:59.000Z");
	});

	it("yields nothing when the account was created this month", () => {
		expect(yearlyWindows(new Date("2026-07-02T00:00:00Z"), now)).toHaveLength(
			0,
		);
	});

	it("covers the same overall range monthlyWindows would", () => {
		const start = new Date("2020-06-20T00:00:00Z");
		const yearly = yearlyWindows(start, now);
		const monthly = monthlyWindows(start, now);
		// Same start instant; both stop before the current month.
		expect(yearly[0].from).toBe(start.toISOString());
		expect(yearly.at(-1)?.to.slice(0, 7)).toBe(
			monthly.at(-1)?.label.slice(0, 7),
		);
	});
});
