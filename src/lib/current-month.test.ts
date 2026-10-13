import { describe, expect, it } from "vitest";
import {
	buildInProgress,
	type CurrentMonthStore,
	isSnapshotFresh,
	monthElapsed,
	projectMonth,
	runCurrentMonthRefresh,
} from "#/lib/current-month";
import type { CommitPoint, MonthlyCount, MonthWindow } from "#/lib/github";

const count = (commits: number): MonthlyCount => ({
	commits,
	restricted: 0,
	issues: 0,
	pullRequests: 0,
	reviews: 0,
	repos: 0,
});

const point = (date: string, commits: number): CommitPoint => ({
	date,
	commits,
	cumulative: 0,
	restricted: 0,
	restrictedCumulative: 0,
	issues: 0,
	pullRequests: 0,
	reviews: 0,
	repos: 0,
});

describe("monthElapsed", () => {
	it("is the fraction of the UTC month gone", () => {
		expect(monthElapsed(new Date("2026-10-01T00:00:00Z"))).toBe(0);
		expect(monthElapsed(new Date("2026-11-16T00:00:00Z"))).toBeCloseTo(0.5);
	});
});

describe("projectMonth", () => {
	it("stays near the usual month after one busy first day instead of spiking", () => {
		// 60 commits on day 1 is a 1,860/month pace; the user usually does 100.
		const projected = projectMonth(count(60), count(100), 1 / 31);
		expect(projected.commits).toBeGreaterThan(60);
		expect(projected.commits).toBeLessThan(400);
	});

	it("follows the real pace once most of the month is in", () => {
		const projected = projectMonth(count(270), count(100), 0.9);
		// Pure pace would be 300; the baseline only pulls the last tenth a little.
		expect(projected.commits).toBeGreaterThanOrEqual(290);
		expect(projected.commits).toBeLessThanOrEqual(300);
	});

	it("never projects below what is already in, and is exact at month end", () => {
		expect(
			projectMonth(count(50), count(0), 0.5).commits,
		).toBeGreaterThanOrEqual(50);
		expect(projectMonth(count(123), count(10), 1).commits).toBe(123);
	});

	it("uses the plain pace without a baseline", () => {
		expect(projectMonth(count(50), null, 0.5).commits).toBe(100);
	});
});

describe("buildInProgress", () => {
	const points = [
		point("2026-07-01", 90),
		point("2026-08-01", 100),
		point("2026-09-01", 110),
	];

	it("attaches a snapshot for the month right after the last completed one", () => {
		const ip = buildInProgress(points, {
			month: "2026-10-01",
			fetchedAt: new Date("2026-10-16T12:00:00Z"),
			counts: count(40),
		});
		expect(ip?.date).toBe("2026-10-01");
		expect(ip?.actual.commits).toBe(40);
		expect(ip?.projected.commits).toBeGreaterThan(40);
	});

	it("shows nothing across a rollover, before the completed month has landed", () => {
		// It's November, September is the last stored month, the snapshot is from October.
		expect(
			buildInProgress(points, {
				month: "2026-11-01",
				fetchedAt: new Date("2026-11-01T06:00:00Z"),
				counts: count(3),
			}),
		).toBeNull();
		expect(buildInProgress(points, null)).toBeNull();
	});
});

describe("isSnapshotFresh", () => {
	const now = new Date("2026-10-13T12:00:00Z");
	it("is fresh within 12 hours of the same month", () => {
		expect(
			isSnapshotFresh(
				{ month: "2026-10-01", fetchedAt: new Date("2026-10-13T01:00:00Z") },
				now,
			),
		).toBe(true);
		expect(
			isSnapshotFresh(
				{ month: "2026-10-01", fetchedAt: new Date("2026-10-12T23:00:00Z") },
				now,
			),
		).toBe(false);
	});
	it("is stale once the month rolls over", () => {
		expect(
			isSnapshotFresh(
				{ month: "2026-10-01", fetchedAt: new Date("2026-10-31T23:00:00Z") },
				new Date("2026-11-01T01:00:00Z"),
			),
		).toBe(false);
	});
});

function fakeStore(opts: { locked?: boolean; fresh?: Set<string> } = {}) {
	const writes: { id: string; month: string; commits: number }[] = [];
	const events: string[] = [];
	const store: CurrentMonthStore = {
		async tryLock() {
			events.push("lock");
			return !opts.locked;
		},
		async releaseLock() {
			events.push("unlock");
		},
		async usersForMetric(metric) {
			return metric === "public"
				? [
						{ id: "user:a", login: "a" },
						{ id: "user:b", login: "b" },
					]
				: [{ id: "user:a", login: "a" }];
		},
		async latestSnapshot(id) {
			return opts.fresh?.has(id)
				? { month: "2026-10-01", fetchedAt: new Date("2026-10-13T11:00:00Z") }
				: null;
		},
		async upsertSnapshot(id, month, counts) {
			writes.push({ id, month, commits: counts.commits });
		},
	};
	return { store, writes, events };
}

const window = (now: Date): MonthWindow => ({
	from: "2026-10-01T00:00:00.000Z",
	to: now.toISOString(),
	label: "2026-10-01",
});

describe("runCurrentMonthRefresh", () => {
	const clock = () => new Date("2026-10-13T12:00:00Z");

	it("refreshes the deduped cohort under the lock and skips fresh users", async () => {
		const { store, writes, events } = fakeStore({ fresh: new Set(["user:b"]) });
		const fetched: string[] = [];
		const result = await runCurrentMonthRefresh({
			store,
			token: "t",
			clock,
			sleep: async () => {},
			monthToDateWindow: window,
			fetchMonthlyCommits: async (login) => {
				fetched.push(login);
				return [count(7)];
			},
		});
		expect(result).toMatchObject({
			status: "completed",
			candidates: 2,
			refreshed: 1,
			skippedFresh: 1,
		});
		expect(fetched).toEqual(["a"]);
		expect(writes).toEqual([{ id: "user:a", month: "2026-10-01", commits: 7 }]);
		expect(events).toEqual(["lock", "unlock"]);
	});

	it("does nothing when another run holds the lock", async () => {
		const { store, writes } = fakeStore({ locked: true });
		const result = await runCurrentMonthRefresh({
			store,
			token: "t",
			clock,
			monthToDateWindow: window,
			fetchMonthlyCommits: async () => [count(1)],
		});
		expect(result.status).toBe("locked");
		expect(writes).toEqual([]);
	});

	it("refreshes a single lookup without the lock, and counts a vanished login as unreachable", async () => {
		const { store, writes, events } = fakeStore();
		const ok = await runCurrentMonthRefresh({
			store,
			token: "t",
			clock,
			candidates: [{ id: "user:c", login: "c" }],
			monthToDateWindow: window,
			fetchMonthlyCommits: async () => [count(3)],
		});
		expect(ok.refreshed).toBe(1);
		expect(writes).toHaveLength(1);
		expect(events).toEqual([]);

		const gone = await runCurrentMonthRefresh({
			store,
			token: "t",
			clock,
			candidates: [{ id: "user:d", login: "d" }],
			monthToDateWindow: window,
			fetchMonthlyCommits: async () => {
				throw Object.assign(new Error("not found"), { status: 404 });
			},
		});
		expect(gone).toMatchObject({ refreshed: 0, unreachable: 1, failed: 0 });
	});

	it("never stores zeros when the fetcher returns nothing", async () => {
		const { store, writes } = fakeStore();
		const result = await runCurrentMonthRefresh({
			store,
			token: "t",
			clock,
			candidates: [{ id: "user:c", login: "c" }],
			monthToDateWindow: window,
			fetchMonthlyCommits: async () => [],
		});
		expect(result.failed).toBe(1);
		expect(writes).toEqual([]);
	});
});
