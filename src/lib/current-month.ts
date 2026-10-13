import type {
	CommitPoint,
	InProgressMonth,
	MonthlyCount,
	MonthWindow,
	RateLimitBudget,
} from "#/lib/github";
import {
	createBudgetGuard,
	defaultSleep,
	type JobLogger,
	positiveInteger,
	quietLogger,
} from "#/lib/job-runner";
import { LEADER_METRICS, type LeaderMetric } from "#/lib/leaderboard-rank";
import {
	candidateUnion,
	type RefreshCandidate,
} from "#/lib/monthly-user-refresh";

/** A lookup re-reads the month-to-date counts at most this often; the daily pass skips anyone fresher. */
export const CURRENT_MONTH_STALE_MS = 12 * 60 * 60_000;

/** The daily pass covers the top N of every leaderboard. */
export const CURRENT_MONTH_LIMIT_PER_METRIC = 250;

/**
 * How quickly the projection trusts this month's own pace over the user's usual month. At `f`
 * elapsed the pace gets weight f / (f + K): ~13% on day 1, ~70% mid-month. Small enough that a
 * real change of pace shows within a week, large enough that one busy first day can't triple the
 * estimate.
 */
const PACE_TRUST_K = 0.2;

/** Completed months averaged into the "usual month" baseline. */
const BASELINE_MONTHS = 3;

const COUNT_KEYS = [
	"commits",
	"restricted",
	"issues",
	"pullRequests",
	"reviews",
	"repos",
] as const satisfies readonly (keyof MonthlyCount)[];

/** Fraction of `at`'s UTC month elapsed, 0–1. */
export function monthElapsed(at: Date): number {
	const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
	const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
	return Math.min(1, Math.max(0, (at.getTime() - start) / (end - start)));
}

/**
 * End-of-month estimate that doesn't spike early in the month: the rate for the rest of the month
 * blends this month's pace with the user's usual month, shifting toward the pace as the month
 * fills in. Converges on the real count at month end and never drops below what's already in.
 * Without a baseline (a brand-new account) it falls back to the plain pace.
 */
export function projectMonth(
	actual: MonthlyCount,
	baseline: MonthlyCount | null,
	elapsed: number,
): MonthlyCount {
	// An hour in, the pace is meaningless; clamp so the division can't explode.
	const f = Math.min(1, Math.max(elapsed, 1 / (31 * 24)));
	const w = baseline ? f / (f + PACE_TRUST_K) : 1;
	const out = { ...actual };
	for (const key of COUNT_KEYS) {
		const pace = actual[key] / f;
		const rate = w * pace + (1 - w) * (baseline?.[key] ?? 0);
		out[key] = Math.max(actual[key], Math.round(actual[key] + (1 - f) * rate));
	}
	return out;
}

/** Mean of the last few completed months, or null without any history. */
export function baselineMonth(points: CommitPoint[]): MonthlyCount | null {
	const recent = points.slice(-BASELINE_MONTHS);
	if (recent.length === 0) return null;
	const sum: MonthlyCount = {
		commits: 0,
		restricted: 0,
		issues: 0,
		pullRequests: 0,
		reviews: 0,
		repos: 0,
	};
	for (const p of recent) for (const key of COUNT_KEYS) sum[key] += p[key];
	for (const key of COUNT_KEYS) sum[key] /= recent.length;
	return sum;
}

export interface MonthToDateSnapshot {
	month: string;
	fetchedAt: Date;
	counts: MonthlyCount;
}

/**
 * The display-only in-progress month for a history, or null when the snapshot doesn't belong
 * right after the last completed point. That covers the rollover: on the 1st, last month's
 * snapshot is stale and the completed month hasn't landed yet, so we show nothing rather than a
 * gap or a month in the wrong slot.
 */
export function buildInProgress(
	points: CommitPoint[],
	snapshot: MonthToDateSnapshot | null,
): InProgressMonth | null {
	const last = points.at(-1);
	if (!snapshot || !last || snapshot.month !== nextMonth(last.date))
		return null;
	const elapsed = monthElapsed(snapshot.fetchedAt);
	return {
		date: snapshot.month,
		fetchedAt: snapshot.fetchedAt.toISOString(),
		elapsed,
		actual: snapshot.counts,
		projected: projectMonth(snapshot.counts, baselineMonth(points), elapsed),
	};
}

/** Whether a snapshot is recent enough that neither a lookup nor the daily pass re-reads it. */
export function isSnapshotFresh(
	latest: { month: string; fetchedAt: Date } | null,
	now: Date,
	staleMs = CURRENT_MONTH_STALE_MS,
): boolean {
	return (
		latest != null &&
		latest.month === monthLabel(now) &&
		now.getTime() - latest.fetchedAt.getTime() < staleMs
	);
}

export interface CurrentMonthStore {
	tryLock(): Promise<boolean>;
	releaseLock(): Promise<void>;
	usersForMetric(
		metric: LeaderMetric,
		limit: number,
	): Promise<RefreshCandidate[]>;
	latestSnapshot(
		id: string,
	): Promise<{ month: string; fetchedAt: Date } | null>;
	upsertSnapshot(
		id: string,
		month: string,
		counts: MonthlyCount,
		fetchedAt: Date,
	): Promise<void>;
}

export interface RunCurrentMonthRefreshOptions {
	store: CurrentMonthStore;
	token: string;
	/**
	 * Refresh exactly these users (a lookup). Without it the run is the daily pass over the top
	 * `limitPerMetric` of every board, which takes the job lock.
	 */
	candidates?: RefreshCandidate[];
	limitPerMetric?: number;
	staleMs?: number;
	maxRuntimeMs?: number;
	ratePerHour?: number;
	remainingFloor?: number;
	pollEvery?: number;
	fetchRateLimit?: () => Promise<RateLimitBudget | null>;
	fetchMonthlyCommits: (
		login: string,
		token: string,
		windows: MonthWindow[],
	) => Promise<MonthlyCount[]>;
	monthToDateWindow: (now: Date) => MonthWindow;
	sleep?: (ms: number) => Promise<void>;
	timeMs?: () => number;
	clock?: () => Date;
	logger?: JobLogger;
}

export interface CurrentMonthRefreshResult {
	status: "completed" | "locked" | "stopped";
	stopReason?: "max_runtime" | "rate_limit_floor";
	candidates: number;
	refreshed: number;
	skippedFresh: number;
	failed: number;
	unreachable: number;
}

export async function runCurrentMonthRefresh(
	opts: RunCurrentMonthRefreshOptions,
): Promise<CurrentMonthRefreshResult> {
	const logger = opts.logger ?? quietLogger;
	const sleep = opts.sleep ?? defaultSleep;
	const timeMs = opts.timeMs ?? Date.now;
	const clock = opts.clock ?? (() => new Date());
	const daily = opts.candidates == null;
	const mode = daily ? "daily" : "lookup";
	const limitPerMetric = positiveInteger(
		opts.limitPerMetric ?? CURRENT_MONTH_LIMIT_PER_METRIC,
		"limitPerMetric",
	);
	const ratePerHour = positiveInteger(opts.ratePerHour ?? 1500, "ratePerHour");
	const remainingFloor = positiveInteger(
		opts.remainingFloor ?? 500,
		"remainingFloor",
	);
	const pollEvery = positiveInteger(opts.pollEvery ?? 25, "pollEvery");
	const staleMs = opts.staleMs ?? CURRENT_MONTH_STALE_MS;
	const startedAt = timeMs();
	const result: CurrentMonthRefreshResult = {
		status: "completed",
		candidates: 0,
		refreshed: 0,
		skippedFresh: 0,
		failed: 0,
		unreachable: 0,
	};

	// Only the daily pass locks: lookups are single idempotent upserts, coalesced per login by the
	// queue, and must not wait behind a multi-hour pass.
	if (daily && !(await opts.store.tryLock())) {
		logger.warn("current-month-refresh status=locked lock=held_elsewhere");
		return { ...result, status: "locked" };
	}

	const runtimeLeftMs = () =>
		opts.maxRuntimeMs ? opts.maxRuntimeMs - (timeMs() - startedAt) : Infinity;
	const budget = createBudgetGuard({
		label: `current-month-refresh mode=${mode}`,
		remainingFloor,
		pollEvery,
		fetchRateLimit: opts.fetchRateLimit,
		sleep,
		nowMs: timeMs,
		runtimeLeftMs,
		logger,
	});

	try {
		const candidates =
			opts.candidates ??
			(await candidateUnion(opts.store, LEADER_METRICS, limitPerMetric));
		result.candidates = candidates.length;
		if (daily) {
			logger.info(
				`current-month-refresh startup mode=daily candidates=${candidates.length} limit_per_metric=${limitPerMetric}`,
			);
		}

		for (const candidate of candidates) {
			if (
				opts.maxRuntimeMs &&
				runtimeLeftMs() <= 0 &&
				result.refreshed + result.failed > 0
			) {
				result.status = "stopped";
				result.stopReason = "max_runtime";
				break;
			}
			if (
				isSnapshotFresh(
					await opts.store.latestSnapshot(candidate.id),
					clock(),
					staleMs,
				)
			) {
				result.skippedFresh += 1;
				continue;
			}
			if (!(await budget.ensure())) {
				result.status = "stopped";
				result.stopReason = "rate_limit_floor";
				break;
			}

			try {
				budget.spend();
				const now = clock();
				const window = opts.monthToDateWindow(now);
				const [counts] = await opts.fetchMonthlyCommits(
					candidate.login,
					opts.token,
					[window],
				);
				// Same rule as the monthly refresh: no counts is a failure, never a stored zero.
				if (!counts)
					throw new Error("no counts returned for the current month");
				await opts.store.upsertSnapshot(
					candidate.id,
					window.label,
					counts,
					now,
				);
				result.refreshed += 1;
				if (!daily) {
					logger.info(
						`current-month-refresh mode=lookup login=${candidate.login} status=refreshed month=${window.label} commits=${counts.commits}`,
					);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const missing =
					typeof err === "object" &&
					err !== null &&
					"status" in err &&
					(err as { status: unknown }).status === 404;
				if (missing) result.unreachable += 1;
				else result.failed += 1;
				logger.warn(
					`current-month-refresh mode=${mode} login=${candidate.login} status=${missing ? "unreachable" : "failed"} error=${JSON.stringify(message)}`,
				);
			}

			if (daily) await sleep((1 / ratePerHour) * 3_600_000);
		}
	} finally {
		if (daily) {
			try {
				await opts.store.releaseLock();
			} catch (err) {
				logger.error(
					`current-month-refresh status=lock_release_failed error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
				);
			}
		}
	}

	if (daily) {
		logger.info(
			`current-month-refresh done mode=daily status=${result.status}${result.stopReason ? ` reason=${result.stopReason}` : ""} candidates=${result.candidates} refreshed=${result.refreshed} skipped_fresh=${result.skippedFresh} failed=${result.failed} unreachable=${result.unreachable}`,
		);
	}
	return result;
}

export function monthLabel(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function nextMonth(label: string): string {
	const [y, m] = label.split("-").map(Number);
	return monthLabel(new Date(Date.UTC(y, m, 1)));
}
