/**
 * Repository leaderboard refresh engine (#212). Pure orchestration over an injected store and
 * fetchers — see repo-refresh-store.ts for the Postgres side and scripts/refresh-repos.ts for the
 * CLI. Follows the background-job recipe in CLAUDE.md:
 *
 *   - unit of work = one repository (the snapshot is 1 point; back-fill batches are 12 months per
 *     point; star back-fill is capped by `maxStars`), so no single repo can monopolise a run;
 *   - resumes off freshness markers: `metrics_fetched_at` / `stats_fetched_at` on the repo row and
 *     final `repository_monthly` rows — a missing row is the retry queue;
 *   - every write is an idempotent upsert;
 *   - per-repo failures are isolated to transient statuses; rate limits stop the run.
 */

import { GitHubError, type MonthWindow, monthlyWindows } from "#/lib/github";
import {
	type ContributorCounts,
	type ContributorStatsResult,
	type ContributorStatsRow,
	MONTHLY_FLOW_BATCH,
	type MonthlyFlow,
	type RepoRef,
	type RepoSnapshot,
} from "#/lib/github-repo";
import type { BudgetGuard, JobLogger } from "#/lib/job-runner";
import {
	backfillStart,
	type ContributorSummary,
	starsByMonth,
	summarizeContributors,
} from "#/lib/repo-metrics";

export interface DueRepo extends RepoRef {
	id: string;
	starsBackfilledAt: Date | null;
}

export interface RepoRefreshStore {
	tryLock(): Promise<boolean>;
	releaseLock(): Promise<void>;
	/** Insert placeholder rows for newly named repos; existing rows are left alone. */
	track(refs: RepoRef[]): Promise<void>;
	/** Repos whose snapshot is older than `staleBefore`, never measured, or whose stats are pending. */
	dueRepos(staleBefore: Date, limit: number): Promise<DueRepo[]>;
	/** Named repos (debug path), regardless of freshness. */
	namedRepos(ids: string[]): Promise<DueRepo[]>;
	saveSnapshot(
		id: string,
		snapshot: RepoSnapshot,
		contributors: ContributorCounts | null,
		now: Date,
	): Promise<void>;
	saveContributorStats(
		id: string,
		stats: ContributorSummary,
		tipSha: string | null,
		now: Date,
	): Promise<void>;
	/** Labels of months already stored as final (fetched at/after the month closed). */
	finalMonths(id: string): Promise<Set<string>>;
	saveMonthlyFlows(
		id: string,
		flows: MonthlyFlow[],
		stats: ContributorSummary | null,
		now: Date,
	): Promise<void>;
	saveStars(id: string, byMonth: Map<string, number>, now: Date): Promise<void>;
	markUnreachable(id: string, now: Date): Promise<void>;
}

export interface RepoFetchers {
	snapshot(ref: RepoRef, now: Date): Promise<RepoSnapshot>;
	contributorStats(ref: RepoRef): Promise<ContributorStatsResult>;
	contributorCounts(ref: RepoRef): Promise<ContributorCounts | null>;
	monthlyFlows(ref: RepoRef, windows: MonthWindow[]): Promise<MonthlyFlow[]>;
	stargazerDates(
		ref: RepoRef,
		onPage: () => Promise<boolean>,
	): Promise<string[] | null>;
}

export interface RunRepoRefreshOptions {
	store: RepoRefreshStore;
	fetchers: RepoFetchers;
	budget: BudgetGuard;
	logger: JobLogger;
	sleep: (ms: number) => Promise<void>;
	now: () => Date;
	/** Remaining wall-clock budget; the run stops cleanly at ≤0. */
	runtimeLeftMs: () => number;
	/** Repos to add to tracking before the run (`owner/name`). */
	track?: RepoRef[];
	/** Debug: refresh exactly these repo ids, ignoring freshness. */
	only?: string[];
	maxRepos: number;
	/** GraphQL points this run may spend in total. */
	maxRequests: number;
	/** A snapshot older than this is due again. */
	staleAfterMs: number;
	/** Waits between `/stats/contributors` attempts while GitHub answers 202. */
	statsRetryDelaysMs: number[];
	backfill: boolean;
	/** Star back-fill is skipped for repos with more stars than this (0 disables it). */
	maxStars: number;
	dryRun?: boolean;
}

export type RepoRefreshStatus =
	| "ok"
	| "locked"
	| "rate_limited"
	| "budget_exhausted"
	| "runtime_exhausted";

export interface RepoRefreshResult {
	status: RepoRefreshStatus;
	repos: number;
	refreshed: number;
	statsPending: number;
	unreachable: number;
	failed: number;
	months: number;
	starPages: number;
	requests: number;
}

// Transient per-repo failures: log, move on, the repo stays due. Rate limits (403/429) are not
// here on purpose — they stop the whole run, because the next repo would only hit them too.
const PER_REPO_FAILURES = new Set([500, 502, 503, 504]);

class StopRun extends Error {
	constructor(readonly status: RepoRefreshStatus) {
		super(status);
	}
}

export async function runRepoRefresh(
	opts: RunRepoRefreshOptions,
): Promise<RepoRefreshResult> {
	const { store, fetchers, budget, logger } = opts;
	const result: RepoRefreshResult = {
		status: "ok",
		repos: 0,
		refreshed: 0,
		statsPending: 0,
		unreachable: 0,
		failed: 0,
		months: 0,
		starPages: 0,
		requests: 0,
	};

	if (!(await store.tryLock())) {
		result.status = "locked";
		return result;
	}

	// One point per GraphQL request, checked against both the per-run cap and the shared floor.
	const spend = async () => {
		if (result.requests >= opts.maxRequests)
			throw new StopRun("budget_exhausted");
		if (opts.runtimeLeftMs() <= 0) throw new StopRun("runtime_exhausted");
		if (!(await budget.ensure())) throw new StopRun("rate_limited");
		budget.spend(1);
		result.requests += 1;
	};

	try {
		if (opts.track?.length && !opts.dryRun) await store.track(opts.track);
		const now = opts.now();
		const queue = opts.only?.length
			? await store.namedRepos(opts.only)
			: await store.dueRepos(
					new Date(now.getTime() - opts.staleAfterMs),
					opts.maxRepos,
				);
		result.repos = queue.length;
		if (opts.dryRun) {
			for (const r of queue) logger.info(`repo-refresh due repo=${r.id}`);
			return result;
		}

		for (const repo of queue) {
			try {
				await refreshOne(repo);
			} catch (e) {
				if (e instanceof StopRun) throw e;
				if (
					e instanceof GitHubError &&
					(e.status === 403 || e.status === 429)
				) {
					throw new StopRun("rate_limited");
				}
				if (e instanceof GitHubError && PER_REPO_FAILURES.has(e.status)) {
					result.failed += 1;
					logger.warn(
						`repo-refresh repo=${repo.id} status=failed http=${e.status} error=${JSON.stringify(e.message)}`,
					);
					continue;
				}
				throw e;
			}
		}
	} catch (e) {
		if (!(e instanceof StopRun)) throw e;
		result.status = e.status;
	} finally {
		await store.releaseLock();
	}
	return result;

	async function refreshOne(repo: DueRepo) {
		const now = opts.now();
		await spend();
		let snapshot: RepoSnapshot;
		try {
			snapshot = await fetchers.snapshot(repo, now);
		} catch (e) {
			if (e instanceof GitHubError && e.status === 404) {
				await store.markUnreachable(repo.id, now);
				result.unreachable += 1;
				logger.warn(`repo-refresh repo=${repo.id} status=unreachable`);
				return;
			}
			throw e;
		}

		const counts = await fetchers.contributorCounts(snapshot);
		const rows = await contributorRows(snapshot);
		const stats = rows ? summarizeContributors(rows, now) : null;
		if (stats) {
			await store.saveContributorStats(
				repo.id,
				stats,
				snapshot.defaultBranchTipSha,
				now,
			);
		} else {
			result.statsPending += 1;
		}
		await store.saveSnapshot(repo.id, snapshot, counts, now);
		result.refreshed += 1;

		if (opts.backfill && snapshot.defaultBranch) {
			const final = await store.finalMonths(repo.id);
			const missing = monthlyWindows(
				backfillStart(new Date(snapshot.createdAt), rows),
				now,
			).filter((w) => !final.has(w.label));
			for (let i = 0; i < missing.length; i += MONTHLY_FLOW_BATCH) {
				await backfillBatch(
					repo.id,
					snapshot,
					missing.slice(i, i + MONTHLY_FLOW_BATCH),
					stats,
				);
			}
		}

		if (
			opts.backfill &&
			opts.maxStars > 0 &&
			!repo.starsBackfilledAt &&
			snapshot.stars <= opts.maxStars
		) {
			// Running out of budget mid-pagination throws StopRun out of here: nothing is written,
			// so the next run starts this repo's star history over.
			const dates = await fetchers.stargazerDates(snapshot, async () => {
				await spend();
				result.starPages += 1;
				return true;
			});
			if (dates)
				await store.saveStars(repo.id, starsByMonth(dates), opts.now());
		}

		logger.info(
			`repo-refresh repo=${repo.id} status=refreshed stars=${snapshot.stars} commits=${snapshot.commits} stats=${stats ? "ready" : "pending"}`,
		);
	}

	/**
	 * One monthly-flow query, halved on a gateway timeout. `history(since, until)` windows get slow
	 * on enormous histories — twelve of them 502 on torvalds/linux (1.4M commits) — and the timeout
	 * is deterministic for the query shape, so retrying the same batch would only fail again.
	 */
	async function backfillBatch(
		id: string,
		ref: RepoRef,
		windows: MonthWindow[],
		stats: ContributorSummary | null,
	): Promise<void> {
		await spend();
		let flows: MonthlyFlow[];
		try {
			flows = await fetchers.monthlyFlows(ref, windows);
		} catch (e) {
			if (
				windows.length > 1 &&
				e instanceof GitHubError &&
				(e.status === 502 || e.status === 504)
			) {
				const mid = Math.ceil(windows.length / 2);
				await backfillBatch(id, ref, windows.slice(0, mid), stats);
				await backfillBatch(id, ref, windows.slice(mid), stats);
				return;
			}
			throw e;
		}
		await store.saveMonthlyFlows(id, flows, stats, opts.now());
		result.months += flows.length;
	}

	/**
	 * Null = no usable statistics this run (still computing, or GitHub declines) — the caller then
	 * leaves the stored stats and `stats_fetched_at` untouched, so nothing reads as fresh.
	 */
	async function contributorRows(
		repo: RepoSnapshot,
	): Promise<ContributorStatsRow[] | null> {
		const delays = [0, ...opts.statsRetryDelaysMs];
		for (const delay of delays) {
			if (delay) await opts.sleep(delay);
			const res = await fetchers.contributorStats(repo);
			if (res.status === "unavailable") return null;
			// While (re)computing, GitHub sometimes answers 200 with an empty list. For a repo that
			// has commits that is not an answer — seen on anza-xyz/agave, stored as 0 contributors.
			if (res.status === "ready" && (res.rows.length || !repo.commits)) {
				return res.rows;
			}
		}
		return null;
	}
}
