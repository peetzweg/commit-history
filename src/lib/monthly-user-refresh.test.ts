import { describe, expect, it } from "vitest";
import {
	resolveTargetMonth,
	runMonthlyUserRefresh,
	type MonthlyRefreshStore,
	type RefreshCandidate,
} from "#/lib/monthly-user-refresh";
import type { MonthlyCount, MonthWindow } from "#/lib/github";

class FakeStore implements MonthlyRefreshStore {
	readonly metricRows: Partial<Record<string, RefreshCandidate[]>>;
	readonly existing = new Set<string>();
	readonly months = new Map<string, MonthlyCount>();
	readonly totals = new Map<string, MonthlyCount>();

	constructor(metricRows: Partial<Record<string, RefreshCandidate[]>>) {
		this.metricRows = metricRows;
	}

	async tryLock() {
		return true;
	}

	async releaseLock() {}

	async usersForMetric(metric: string, limit: number) {
		return (this.metricRows[metric] ?? []).slice(0, limit);
	}

	async hasMonth(id: string, month: string) {
		return this.existing.has(`${id}:${month}`);
	}

	async upsertMonth(id: string, month: string, counts: MonthlyCount) {
		this.existing.add(`${id}:${month}`);
		this.months.set(`${id}:${month}`, counts);
	}

	async recomputeTotals(id: string) {
		const total = {
			commits: 0,
			restricted: 0,
			issues: 0,
			pullRequests: 0,
			reviews: 0,
			repos: 0,
		};
		for (const [key, counts] of this.months) {
			if (!key.startsWith(`${id}:`)) continue;
			total.commits += counts.commits;
			total.restricted += counts.restricted;
			total.issues += counts.issues;
			total.pullRequests += counts.pullRequests;
			total.reviews += counts.reviews;
			total.repos += counts.repos;
		}
		this.totals.set(id, total);
		return total;
	}
}

const candidate = (login: string): RefreshCandidate => ({
	id: `user:${login.toLowerCase()}`,
	login,
});

describe("resolveTargetMonth", () => {
	it("uses the newest completed UTC month after the configured first-day safety time", () => {
		expect(
			resolveTargetMonth({
				now: new Date("2026-08-01T03:00:00Z"),
				safeAfterUtc: "03:00",
			}),
		).toEqual({ ok: true, month: "2026-07-01" });
	});

	it("exits early before the configured first-day safety time", () => {
		expect(
			resolveTargetMonth({
				now: new Date("2026-08-01T02:59:59Z"),
				safeAfterUtc: "03:00",
			}),
		).toEqual({
			ok: false,
			reason: "too_early",
			month: "2026-07-01",
			safeAt: "2026-08-01T03:00:00.000Z",
		});
	});
});

describe("runMonthlyUserRefresh", () => {
	it("refreshes a deterministic metric union, skipping users that already have the month", async () => {
		const store = new FakeStore({
			public: [candidate("Ada"), candidate("Grace")],
			prs: [candidate("Grace"), candidate("Linus")],
		});
		store.existing.add("user:grace:2026-07-01");
		const fetched: string[] = [];

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-08-01T04:00:00Z"),
			targetMonth: "2026-07-01",
			metrics: ["public", "prs"],
			limitPerMetric: 2,
			ratePerHour: 3600,
			sleep: async () => {},
			fetchMonthlyCommits: async (login, _token, windows) => {
				fetched.push(`${login}:${windows.map((w) => w.label).join(",")}`);
				return [
					{
						commits: login === "Ada" ? 10 : 3,
						restricted: 1,
						issues: 2,
						pullRequests: 3,
						reviews: 4,
						repos: 5,
					},
				];
			},
		});

		expect(fetched).toEqual(["Ada:2026-07-01", "Linus:2026-07-01"]);
		expect(result).toMatchObject({
			targetMonth: "2026-07-01",
			candidates: 3,
			skippedFresh: 1,
			refreshed: 2,
			failed: 0,
			dryRun: false,
		});
		expect(store.totals.get("user:ada")).toEqual({
			commits: 10,
			restricted: 1,
			issues: 2,
			pullRequests: 3,
			reviews: 4,
			repos: 5,
		});
	});

	it("retries a failed user once and leaves the month missing when both attempts fail", async () => {
		const store = new FakeStore({ public: [candidate("Failing")] });
		let attempts = 0;

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-08-01T04:00:00Z"),
			targetMonth: "2026-07-01",
			metrics: ["public"],
			limitPerMetric: 1,
			ratePerHour: 3600,
			sleep: async () => {},
			fetchMonthlyCommits: async () => {
				attempts += 1;
				throw new Error("rate limited");
			},
		});

		expect(attempts).toBe(2);
		expect(result.failed).toBe(1);
		expect(store.existing.has("user:failing:2026-07-01")).toBe(false);
	});

	it("does not write during dry runs", async () => {
		const store = new FakeStore({ public: [candidate("Ada")] });
		let calls = 0;

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-08-01T04:00:00Z"),
			targetMonth: "2026-07-01",
			metrics: ["public"],
			limitPerMetric: 1,
			ratePerHour: 3600,
			dryRun: true,
			sleep: async () => {},
			fetchMonthlyCommits: async (_login, _token, windows: MonthWindow[]) => {
				calls += 1;
				return windows.map(() => ({
					commits: 1,
					restricted: 0,
					issues: 0,
					pullRequests: 0,
					reviews: 0,
					repos: 0,
				}));
			},
		});

		expect(calls).toBe(0);
		expect(result.dryRunWouldRefresh).toBe(1);
		expect(store.existing.size).toBe(0);
	});

	it("refuses to write a manually overridden current month", async () => {
		const store = new FakeStore({ public: [candidate("Ada")] });

		await expect(
			runMonthlyUserRefresh({
				store,
				token: "token",
				now: new Date("2026-07-29T12:00:00Z"),
				targetMonth: "2026-07-01",
				metrics: ["public"],
				limitPerMetric: 1,
				ratePerHour: 3600,
				sleep: async () => {},
				fetchMonthlyCommits: async () => [],
			}),
		).rejects.toThrow("not completed");
		expect(store.existing.size).toBe(0);
	});

	it("can explicitly allow a manually overridden current month", async () => {
		const store = new FakeStore({ public: [candidate("Ada")] });

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-07-29T12:00:00Z"),
			targetMonth: "2026-07-01",
			allowIncompleteMonth: true,
			metrics: ["public"],
			limitPerMetric: 1,
			ratePerHour: 3600,
			sleep: async () => {},
			fetchMonthlyCommits: async () => [
				{
					commits: 1,
					restricted: 0,
					issues: 0,
					pullRequests: 0,
					reviews: 0,
					repos: 0,
				},
			],
		});

		expect(result.refreshed).toBe(1);
		expect(store.existing.has("user:ada:2026-07-01")).toBe(true);
	});

	it("caps the deterministic union by round-robining metric buckets", async () => {
		const store = new FakeStore({
			public: [candidate("Charlie"), candidate("Ada")],
			prs: [candidate("Grace"), candidate("Linus")],
		});
		const fetched: string[] = [];

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-08-01T04:00:00Z"),
			targetMonth: "2026-07-01",
			metrics: ["public", "prs"],
			limitPerMetric: 2,
			maxUsers: 2,
			ratePerHour: 3600,
			sleep: async () => {},
			fetchMonthlyCommits: async (login) => {
				fetched.push(login);
				return [
					{
						commits: 1,
						restricted: 0,
						issues: 0,
						pullRequests: 0,
						reviews: 0,
						repos: 0,
					},
				];
			},
		});

		expect(fetched).toEqual(["Charlie", "Grace"]);
		expect(result.candidates).toBe(2);
		expect(result.refreshed).toBe(2);
	});
});
