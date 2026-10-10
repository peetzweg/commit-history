import { describe, expect, it } from "vitest";
import { GitHubError, type MonthWindow } from "#/lib/github";
import type {
	ContributorCounts,
	ContributorStatsResult,
	MonthlyFlow,
	RepoRef,
	RepoSnapshot,
} from "#/lib/github-repo";
import { type BudgetGuard, quietLogger } from "#/lib/job-runner";
import type { ContributorSummary } from "#/lib/repo-metrics";
import {
	type DueRepo,
	type RepoFetchers,
	type RepoRefreshStore,
	type RunRepoRefreshOptions,
	runRepoRefresh,
} from "#/lib/repo-refresh";

const NOW = new Date("2026-09-28T06:00:00Z");

function snapshot(
	ref: RepoRef,
	over: Partial<RepoSnapshot> = {},
): RepoSnapshot {
	return {
		nodeId: `node-${ref.name}`,
		owner: ref.owner,
		name: ref.name,
		description: null,
		ownerAvatarUrl: null,
		primaryLanguage: "Rust",
		license: null,
		// Three closed months before NOW: June, July, August 2026.
		createdAt: "2026-06-10T00:00:00Z",
		pushedAt: "2026-09-27T00:00:00Z",
		isArchived: false,
		isFork: false,
		defaultBranch: "master",
		defaultBranchTipSha: "abc123",
		commits: 100,
		commitsLastYear: 40,
		stars: 250,
		forks: 3,
		watchers: 2,
		openIssues: 1,
		closedIssues: 1,
		openPullRequests: 1,
		mergedPullRequests: 5,
		closedPullRequests: 0,
		releases: 0,
		...over,
	};
}

class FakeStore implements RepoRefreshStore {
	locked = false;
	released = 0;
	repos = new Map<string, DueRepo & { unreachable?: boolean }>();
	snapshots: Array<{ id: string; contributors: ContributorCounts | null }> = [];
	stats = new Map<string, ContributorSummary>();
	monthly = new Map<string, Map<string, MonthlyFlow & { fetchedAt: Date }>>();
	stars = new Map<string, Map<string, number>>();

	add(id: string, starsBackfilledAt: Date | null = null) {
		const [owner, name] = id.split("/");
		this.repos.set(id, { id, owner, name, starsBackfilledAt });
	}
	async tryLock() {
		if (this.locked) return false;
		this.locked = true;
		return true;
	}
	async releaseLock() {
		this.released += 1;
		this.locked = false;
	}
	async track(refs: RepoRef[]) {
		for (const r of refs) {
			const id = `${r.owner}/${r.name}`.toLowerCase();
			if (!this.repos.has(id)) this.add(id);
		}
	}
	async dueRepos() {
		return [...this.repos.values()].filter((r) => !r.unreachable);
	}
	async namedRepos(ids: string[]) {
		return ids.flatMap((id) => this.repos.get(id) ?? []);
	}
	async saveSnapshot(
		id: string,
		_s: RepoSnapshot,
		contributors: ContributorCounts | null,
	) {
		this.snapshots.push({ id, contributors });
	}
	async saveContributorStats(id: string, stats: ContributorSummary) {
		this.stats.set(id, stats);
	}
	async finalMonths(id: string) {
		return new Set(this.monthly.get(id)?.keys() ?? []);
	}
	async saveMonthlyFlows(
		id: string,
		flows: MonthlyFlow[],
		_s: unknown,
		now: Date,
	) {
		const m = this.monthly.get(id) ?? new Map();
		for (const f of flows) m.set(f.month, { ...f, fetchedAt: now });
		this.monthly.set(id, m);
	}
	async saveStars(id: string, byMonth: Map<string, number>) {
		this.stars.set(id, byMonth);
	}
	async markUnreachable(id: string) {
		const r = this.repos.get(id);
		if (r) r.unreachable = true;
	}
}

function fetchers(over: Partial<RepoFetchers> = {}) {
	const calls = { stats: 0, flows: [] as MonthWindow[][], starPages: 0 };
	const f: RepoFetchers = {
		snapshot: async (ref) => snapshot(ref),
		contributorCounts: async () => ({ total: 7, linked: 6 }),
		contributorStats: async (): Promise<ContributorStatsResult> => {
			calls.stats += 1;
			return {
				status: "ready",
				rows: [
					{
						author: { login: "a" },
						total: 5,
						weeks: [{ w: Date.parse("2026-07-05T00:00:00Z") / 1000, c: 5 }],
					},
				],
			};
		},
		monthlyFlows: async (_ref, windows) => {
			calls.flows.push(windows);
			return windows.map((w) => ({
				month: w.label,
				commits: 1,
				issuesOpened: 0,
				issuesClosed: 0,
				pullRequestsOpened: 0,
				pullRequestsMerged: 0,
			}));
		},
		stargazerDates: async (_ref, onPage) => {
			for (let i = 0; i < 3; i++) {
				if (!(await onPage())) return null;
				calls.starPages += 1;
			}
			return ["2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"];
		},
		...over,
	};
	return { f, calls };
}

const openBudget: BudgetGuard = {
	ensure: async () => true,
	spend: () => {},
	spent: () => 0,
};

function options(
	store: FakeStore,
	f: RepoFetchers,
	over: Partial<RunRepoRefreshOptions> = {},
): RunRepoRefreshOptions {
	return {
		store,
		fetchers: f,
		budget: openBudget,
		logger: quietLogger,
		sleep: async () => {},
		now: () => NOW,
		runtimeLeftMs: () => 60_000,
		maxRepos: 50,
		maxRequests: 100,
		staleAfterMs: 20 * 3_600_000,
		statsRetryDelaysMs: [1, 1],
		backfill: true,
		maxStars: 1_000,
		...over,
	};
}

describe("runRepoRefresh", () => {
	it("snapshots, computes stats, back-fills every closed month and the star history", async () => {
		const store = new FakeStore();
		const { f, calls } = fetchers();
		const res = await runRepoRefresh(
			options(store, f, {
				track: [{ owner: "paritytech", name: "polkadot-sdk" }],
			}),
		);
		expect(res).toMatchObject({
			status: "ok",
			refreshed: 1,
			months: 3,
			starPages: 3,
		});
		// 1 snapshot + 1 monthly batch + 3 star pages.
		expect(res.requests).toBe(5);
		expect([
			...(store.monthly.get("paritytech/polkadot-sdk")?.keys() ?? []),
		]).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
		expect(store.stats.get("paritytech/polkadot-sdk")?.rows).toBe(1);
		expect(store.snapshots[0].contributors).toEqual({ total: 7, linked: 6 });
		expect(store.stars.get("paritytech/polkadot-sdk")?.get("2026-07-01")).toBe(
			2,
		);
		expect(calls.flows[0]).toHaveLength(3);
		expect(store.released).toBe(1);
	});

	it("resumes the back-fill: months already final are not fetched again", async () => {
		const store = new FakeStore();
		store.add("o/r", NOW);
		const { f, calls } = fetchers();
		await runRepoRefresh(options(store, f));
		await runRepoRefresh(options(store, f));
		expect(calls.flows).toHaveLength(1);
		// Stars were already back-filled for this repo.
		expect(calls.starPages).toBe(0);
	});

	it("retries 202 contributor statistics and records them as pending when GitHub never finishes", async () => {
		const store = new FakeStore();
		store.add("o/r");
		let attempts = 0;
		const { f } = fetchers({
			contributorStats: async () => {
				attempts += 1;
				return { status: "pending" };
			},
		});
		const res = await runRepoRefresh(options(store, f));
		expect(attempts).toBe(3); // first try + two retry delays
		expect(res.statsPending).toBe(1);
		expect(store.stats.has("o/r")).toBe(false);
		// The snapshot (and its contributor count) is still written.
		expect(store.snapshots).toHaveLength(1);
	});

	it("uses statistics once a retry succeeds", async () => {
		const store = new FakeStore();
		store.add("o/r");
		const answers: ContributorStatsResult[] = [
			{ status: "pending" },
			{
				status: "ready",
				rows: [{ author: { login: "a" }, total: 1, weeks: [] }],
			},
		];
		const { f } = fetchers({
			contributorStats: async () => answers.shift() ?? answers[0],
		});
		const res = await runRepoRefresh(options(store, f));
		expect(res.statsPending).toBe(0);
		expect(store.stats.get("o/r")?.rows).toBe(1);
	});

	it("does not accept an empty statistics answer for a repo that has commits", async () => {
		const store = new FakeStore();
		store.add("o/r");
		const { f } = fetchers({
			contributorStats: async () => ({ status: "ready", rows: [] }),
		});
		const res = await runRepoRefresh(options(store, f));
		expect(res.statsPending).toBe(1);
		expect(store.stats.has("o/r")).toBe(false);

		const empty = new FakeStore();
		empty.add("o/empty");
		const emptyRepo = fetchers({
			snapshot: async (ref) => snapshot(ref, { commits: 0 }),
			contributorStats: async () => ({ status: "ready", rows: [] }),
		});
		await runRepoRefresh(options(empty, emptyRepo.f));
		expect(empty.stats.get("o/empty")?.rows).toBe(0);
	});

	it("writes no statistics when GitHub declines to compute them", async () => {
		const store = new FakeStore();
		store.add("o/r");
		const { f } = fetchers({
			contributorStats: async () => ({ status: "unavailable" }),
		});
		await runRepoRefresh(options(store, f));
		expect(store.stats.has("o/r")).toBe(false);
		expect(store.snapshots).toHaveLength(1);
	});

	it("marks a repo GitHub no longer resolves as unreachable and moves on", async () => {
		const store = new FakeStore();
		store.add("gone/repo");
		store.add("o/r");
		const { f } = fetchers({
			snapshot: async (ref) => {
				if (ref.owner === "gone") throw new GitHubError("not found", 404);
				return snapshot(ref);
			},
		});
		const res = await runRepoRefresh(options(store, f));
		expect(res).toMatchObject({ unreachable: 1, refreshed: 1, status: "ok" });
		expect(store.repos.get("gone/repo")?.unreachable).toBe(true);
	});

	it("isolates transient failures to the repo but stops the whole run on a rate limit", async () => {
		const store = new FakeStore();
		store.add("a/one");
		store.add("b/two");
		const flaky = fetchers({
			snapshot: async (ref) => {
				if (ref.owner === "a") throw new GitHubError("boom", 502);
				return snapshot(ref);
			},
		});
		expect(await runRepoRefresh(options(store, flaky.f))).toMatchObject({
			failed: 1,
			refreshed: 1,
		});

		const limited = fetchers({
			snapshot: async () => {
				throw new GitHubError("slow down", 403);
			},
		});
		const res = await runRepoRefresh(options(store, limited.f));
		expect(res).toMatchObject({ status: "rate_limited", refreshed: 0 });
		expect(store.locked).toBe(false);
	});

	it("halves a monthly batch that times out instead of failing the repo", async () => {
		const store = new FakeStore();
		store.add("torvalds/linux", NOW);
		const sizes: number[] = [];
		const { f } = fetchers({
			monthlyFlows: async (_ref, windows) => {
				sizes.push(windows.length);
				if (windows.length > 1) throw new GitHubError("timeout", 502);
				return windows.map((w) => ({
					month: w.label,
					commits: 1,
					issuesOpened: 0,
					issuesClosed: 0,
					pullRequestsOpened: 0,
					pullRequestsMerged: 0,
				}));
			},
		});
		const res = await runRepoRefresh(options(store, f));
		expect(res).toMatchObject({ failed: 0, months: 3 });
		expect(sizes).toEqual([3, 2, 1, 1, 1]);
	});

	it("skips star history over the cap and stops at the request budget", async () => {
		const store = new FakeStore();
		store.add("o/r");
		const { f, calls } = fetchers({
			snapshot: async (ref) => snapshot(ref, { stars: 5_000 }),
		});
		await runRepoRefresh(options(store, f));
		expect(calls.starPages).toBe(0);

		const capped = new FakeStore();
		capped.add("x/one");
		capped.add("y/two");
		const res = await runRepoRefresh(
			options(capped, fetchers().f, { maxRequests: 1, backfill: false }),
		);
		expect(res).toMatchObject({ status: "budget_exhausted", refreshed: 1 });
	});

	it("reports locked without touching anything when another run holds the lock", async () => {
		const store = new FakeStore();
		store.locked = true;
		store.add("o/r");
		const res = await runRepoRefresh(options(store, fetchers().f));
		expect(res.status).toBe("locked");
		expect(store.snapshots).toHaveLength(0);
	});
});
