import { describe, expect, it } from "vitest";
import type { MonthlyCount, MonthWindow } from "#/lib/github";
import {
	type MonthlyRefreshStore,
	type RefreshCandidate,
	resolveTargetMonth,
	runMonthlyUserRefresh,
} from "#/lib/monthly-user-refresh";

/** First instant after `month` (YYYY-MM-01) ends, in UTC — the completeness boundary. */
function monthEnd(month: string): Date {
	const [year, m] = month.split("-").map(Number);
	return new Date(Date.UTC(year, m, 1));
}

class FakeStore implements MonthlyRefreshStore {
	readonly metricRows: Partial<Record<string, RefreshCandidate[]>>;
	/** month key → the row as stored, mirroring the real table's (counts, fetched_at). */
	readonly rows = new Map<
		string,
		{ counts: MonthlyCount; fetchedAt: Date | null }
	>();
	readonly totals = new Map<string, MonthlyCount>();
	readonly unreachable = new Map<string, Date>();

	constructor(metricRows: Partial<Record<string, RefreshCandidate[]>>) {
		this.metricRows = metricRows;
	}

	/** Seed a row read *after* the month closed — the only kind that counts as done. */
	seedComplete(id: string, month: string) {
		this.rows.set(`${id}:${month}`, {
			counts: zero(),
			fetchedAt: new Date(monthEnd(month).getTime() + 60_000),
		});
	}

	/**
	 * Seed a row read *during* the month, the pre-a44f442 shape: it exists but holds a few days.
	 * `fetchedAt: null` models the rows that predate the column entirely.
	 */
	seedPartial(id: string, month: string, fetchedAt: Date | null = null) {
		this.rows.set(`${id}:${month}`, { counts: zero(), fetchedAt });
	}

	/** Row keys that exist at all, regardless of completeness. */
	get storedKeys() {
		return new Set(this.rows.keys());
	}

	private complete(key: string) {
		const row = this.rows.get(key);
		if (!row?.fetchedAt) return false;
		const month = key.slice(key.lastIndexOf(":") + 1);
		return row.fetchedAt.getTime() >= monthEnd(month).getTime();
	}

	async tryLock() {
		return true;
	}

	async releaseLock() {}

	async usersForMetric(metric: string, limit: number) {
		return (this.metricRows[metric] ?? [])
			.filter((c) => !this.unreachable.has(c.id))
			.slice(0, limit);
	}

	async countIncompleteMonth(ids: string[], month: string) {
		return ids.filter((id) => !this.complete(`${id}:${month}`)).length;
	}

	async hasCompleteMonth(id: string, month: string) {
		return this.complete(`${id}:${month}`);
	}

	async upsertMonth(
		id: string,
		month: string,
		counts: MonthlyCount,
		fetchedAt: Date,
	) {
		this.rows.set(`${id}:${month}`, { counts, fetchedAt });
	}

	async markUnreachable(id: string, at: Date) {
		this.unreachable.set(id, at);
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
		for (const [key, row] of this.rows) {
			if (!key.startsWith(`${id}:`)) continue;
			total.commits += row.counts.commits;
			total.restricted += row.counts.restricted;
			total.issues += row.counts.issues;
			total.pullRequests += row.counts.pullRequests;
			total.reviews += row.counts.reviews;
			total.repos += row.counts.repos;
		}
		this.totals.set(id, total);
		return total;
	}
}

const zero = (): MonthlyCount => ({
	commits: 0,
	restricted: 0,
	issues: 0,
	pullRequests: 0,
	reviews: 0,
	repos: 0,
});

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
	it("refreshes a deterministic metric union, skipping users whose month is already complete", async () => {
		const store = new FakeStore({
			public: [candidate("Ada"), candidate("Grace")],
			prs: [candidate("Grace"), candidate("Linus")],
		});
		store.seedComplete("user:grace", "2026-07-01");
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
			incompleteTargetMonth: 2,
			skippedComplete: 1,
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
		expect(store.storedKeys.has("user:failing:2026-07-01")).toBe(false);
	});

	it("waits for the window to reset when the budget dips below the floor", async () => {
		const store = new FakeStore({
			public: [candidate("Ada"), candidate("Grace")],
		});
		const clock = 1_800_000_000_000;
		const slept: number[] = [];
		const budgets = [
			{ remaining: 5_000, resetAt: new Date(clock + 600_000).toISOString() },
			{ remaining: 120, resetAt: new Date(clock + 600_000).toISOString() },
			{ remaining: 5_000, resetAt: new Date(clock + 4_200_000).toISOString() },
		];
		let polls = 0;

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-08-01T04:00:00Z"),
			targetMonth: "2026-07-01",
			metrics: ["public"],
			limitPerMetric: 2,
			ratePerHour: 3600,
			remainingFloor: 500,
			pollEvery: 1,
			maxRuntimeMs: 60 * 60_000,
			timeMs: () => clock,
			sleep: async (ms) => {
				slept.push(ms);
			},
			fetchRateLimit: async () => budgets[polls++] ?? budgets[2],
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

		expect(result.status).toBe("completed");
		expect(result.refreshed).toBe(2);
		// Slept until the reported reset (+1s) rather than spending below the floor.
		expect(slept).toContain(601_000);
	});

	it("stops instead of sleeping past its max runtime when below the floor", async () => {
		const store = new FakeStore({ public: [candidate("Ada")] });
		const clock = 1_800_000_000_000;
		let fetches = 0;

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-08-01T04:00:00Z"),
			targetMonth: "2026-07-01",
			metrics: ["public"],
			limitPerMetric: 1,
			ratePerHour: 3600,
			remainingFloor: 500,
			maxRuntimeMs: 10 * 60_000,
			timeMs: () => clock,
			sleep: async () => {},
			// Window resets in 50 minutes, well past the 10-minute runtime budget.
			fetchRateLimit: async () => ({
				remaining: 12,
				resetAt: new Date(clock + 50 * 60_000).toISOString(),
			}),
			fetchMonthlyCommits: async () => {
				fetches += 1;
				return [];
			},
		});

		expect(fetches).toBe(0);
		expect(result.status).toBe("stopped");
		expect(result.stopReason).toBe("rate_limit_floor");
		expect(store.rows.size).toBe(0);
	});

	it("re-polls the real budget before retrying a failed user", async () => {
		const store = new FakeStore({ public: [candidate("Failing")] });
		const clock = 1_800_000_000_000;
		let polls = 0;
		let attempts = 0;

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-08-01T04:00:00Z"),
			targetMonth: "2026-07-01",
			metrics: ["public"],
			limitPerMetric: 1,
			ratePerHour: 3600,
			remainingFloor: 500,
			maxRuntimeMs: 10 * 60_000,
			timeMs: () => clock,
			sleep: async () => {},
			fetchRateLimit: async () => {
				polls += 1;
				// Healthy before the request, exhausted by the time it fails.
				return polls === 1
					? {
							remaining: 5_000,
							resetAt: new Date(clock + 600_000).toISOString(),
						}
					: {
							remaining: 3,
							resetAt: new Date(clock + 50 * 60_000).toISOString(),
						};
			},
			fetchMonthlyCommits: async () => {
				attempts += 1;
				throw new Error("You have exceeded a secondary rate limit");
			},
		});

		// The failure was the rate limit: the second attempt is abandoned rather than fired into
		// a wall, and the missing month row stays as the retry queue for the next pass.
		expect(attempts).toBe(1);
		expect(polls).toBe(2);
		expect(result.failed).toBe(1);
		expect(store.storedKeys.has("user:failing:2026-07-01")).toBe(false);
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
		expect(store.rows.size).toBe(0);
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
		expect(store.rows.size).toBe(0);
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
		expect(store.storedKeys.has("user:ada:2026-07-01")).toBe(true);
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

	// Regression: the 2026-08-01 run skipped 2229 of 2230 candidates because the gate asked "is
	// there a row?" instead of "was it read after the month closed?". Rows written mid-month before
	// a44f442 (and every row predating fetched_at) must be re-fetched, not counted as done.
	it("re-fetches a month whose row was stored before the month closed", async () => {
		const store = new FakeStore({
			public: [candidate("Peppy"), candidate("Antfu"), candidate("Grace")],
		});
		// Written on 2026-07-02, while July was still running — one day of data under July's label.
		store.seedPartial(
			"user:peppy",
			"2026-07-01",
			new Date("2026-07-02T09:00:00Z"),
		);
		// Predates the fetched_at column entirely: provenance unknown, so not trusted.
		store.seedPartial("user:antfu", "2026-07-01", null);
		// Genuinely done.
		store.seedComplete("user:grace", "2026-07-01");
		const fetched: string[] = [];

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-08-01T04:00:00Z"),
			targetMonth: "2026-07-01",
			metrics: ["public"],
			limitPerMetric: 3,
			ratePerHour: 3600,
			sleep: async () => {},
			clock: () => new Date("2026-08-01T04:05:00Z"),
			fetchMonthlyCommits: async (login) => {
				fetched.push(login);
				return [{ ...zero(), commits: 88 }];
			},
		});

		expect(fetched).toEqual(["Peppy", "Antfu"]);
		expect(result).toMatchObject({
			candidates: 3,
			incompleteTargetMonth: 2,
			skippedComplete: 1,
			refreshed: 2,
			failed: 0,
		});
		// Repaired rows now carry a stamp after the month's end, so the next pass skips them.
		expect(await store.hasCompleteMonth("user:peppy", "2026-07-01")).toBe(true);
	});

	it("marks a login GitHub can no longer resolve instead of retrying and failing it", async () => {
		const store = new FakeStore({ public: [candidate("ageesen")] });
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
			clock: () => new Date("2026-08-01T04:05:00Z"),
			fetchMonthlyCommits: async () => {
				attempts += 1;
				// Shape of the GitHubError github.ts raises for "Could not resolve to a User".
				throw Object.assign(
					new Error("Could not resolve to a User with the login of 'ageesen'."),
					{ status: 404 },
				);
			},
		});

		// A 404 is terminal — retrying it only spends a second request on the shared token.
		expect(attempts).toBe(1);
		expect(result.unreachable).toBe(1);
		expect(result.failed).toBe(0);
		expect(store.unreachable.get("user:ageesen")).toEqual(
			new Date("2026-08-01T04:05:00Z"),
		);
		// The month stays unwritten, but the entity drops out of the cohort, so it is not retried.
		expect(store.storedKeys.has("user:ageesen:2026-07-01")).toBe(false);
		expect(await store.usersForMetric("public", 1)).toEqual([]);
	});

	it("treats an empty fetch result as a failure rather than writing a zeroed month", async () => {
		const store = new FakeStore({ public: [candidate("Ada")] });

		const result = await runMonthlyUserRefresh({
			store,
			token: "token",
			now: new Date("2026-08-01T04:00:00Z"),
			targetMonth: "2026-07-01",
			metrics: ["public"],
			limitPerMetric: 1,
			ratePerHour: 3600,
			sleep: async () => {},
			fetchMonthlyCommits: async () => [],
		});

		expect(result.failed).toBe(1);
		expect(result.refreshed).toBe(0);
		// Writing zeros would have looked like success and blanked the month permanently.
		expect(store.storedKeys.has("user:ada:2026-07-01")).toBe(false);
	});
});
