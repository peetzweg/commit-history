import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchMonthlyCommits,
	isValidLogin,
	type MonthWindow,
	monthlyWindows,
	yearlyWindows,
} from "#/lib/github";

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

describe("fetchMonthlyCommits adaptive batching", () => {
	afterEach(() => vi.unstubAllGlobals());

	// A GraphQL "resource limits exceeded" body (HTTP 200 with errors), as GitHub returns when
	// a batch bundles too many expensive contributionsCollection windows.
	const resourceLimit = {
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => ({
			errors: [{ message: "Resource limits for this query exceeded." }],
		}),
	};
	const dataFor = (aliasCount: number) => {
		const user: Record<string, unknown> = {};
		for (let i = 0; i < aliasCount; i++) {
			user[`w${i}`] = {
				totalCommitContributions: 1,
				restrictedContributionsCount: 0,
				totalIssueContributions: 0,
				totalPullRequestContributions: 0,
				totalPullRequestReviewContributions: 0,
				totalRepositoryContributions: 0,
			};
		}
		return {
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () => ({ data: { user } }),
		};
	};
	const aliasCount = (init: RequestInit) => {
		const { query } = JSON.parse(init.body as string) as { query: string };
		return (query.match(/contributionsCollection/g) ?? []).length;
	};
	const windows = (n: number): MonthWindow[] =>
		monthlyWindows(new Date("2019-01-01T00:00:00Z"), new Date()).slice(0, n);

	it("splits an over-limit batch and reassembles all windows in order", async () => {
		let maxAliasSeen = 0;
		// Any query wider than 3 windows trips the limit; 3-or-fewer succeed — so the initial
		// 6-window batch must be split before it can complete.
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const n = aliasCount(init);
			maxAliasSeen = Math.max(maxAliasSeen, n);
			return n > 3 ? resourceLimit : dataFor(n);
		});

		const ws = windows(6);
		const counts = await fetchMonthlyCommits("someactiveuser", "tok", ws);

		expect(maxAliasSeen).toBe(6); // the wide batch was attempted (and rejected) first
		expect(counts).toHaveLength(6); // every window survives the split
		expect(counts.every((c) => c.commits === 1)).toBe(true);
	});

	it("degrades a single window that always exceeds the limit to a zero month", async () => {
		// Even a one-window query is rejected — the last-resort zero path must engage.
		vi.stubGlobal("fetch", async () => resourceLimit);

		const counts = await fetchMonthlyCommits("someuser", "tok", windows(2));

		expect(counts).toHaveLength(2);
		expect(counts).toEqual([
			{
				commits: 0,
				restricted: 0,
				issues: 0,
				pullRequests: 0,
				reviews: 0,
				repos: 0,
			},
			{
				commits: 0,
				restricted: 0,
				issues: 0,
				pullRequests: 0,
				reviews: 0,
				repos: 0,
			},
		]);
	});
});
