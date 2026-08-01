import type { MonthlyCount, MonthWindow, RateLimitBudget } from "#/lib/github";
import { LEADER_METRICS, type LeaderMetric } from "#/lib/leaderboard-rank";

/**
 * The cohort is "the top N of every leaderboard", so it is defined by the boards themselves.
 * Re-exported from the ranking module rather than restated here — a metric added to the product
 * must not silently go unrefreshed.
 */
export const USER_REFRESH_METRICS = LEADER_METRICS;

export type UserRefreshMetric = LeaderMetric;

export interface RefreshCandidate {
	id: string;
	login: string;
}

export interface MonthlyRefreshStore {
	tryLock(): Promise<boolean>;
	releaseLock(): Promise<void>;
	usersForMetric(
		metric: UserRefreshMetric,
		limit: number,
	): Promise<RefreshCandidate[]>;
	/** How many of `ids` still need `month` — the startup log's work-queue size. */
	countIncompleteMonth(ids: string[], month: string): Promise<number>;
	/**
	 * Whether `month` is stored *and* was read after the month closed. Existence alone is not
	 * enough: rows written before a44f442 hold a few mid-month days under the month's label, so
	 * gating on existence froze them forever (2026-08-01 incident). See `monthly_commits.fetchedAt`.
	 */
	hasCompleteMonth(id: string, month: string): Promise<boolean>;
	upsertMonth(
		id: string,
		month: string,
		counts: MonthlyCount,
		fetchedAt: Date,
	): Promise<void>;
	recomputeTotals(id: string, fetchedAt: Date): Promise<MonthlyCount>;
	/** GitHub no longer resolves this login — drop it from future cohorts. */
	markUnreachable(id: string, at: Date): Promise<void>;
}

export interface MonthlyRefreshLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface RunMonthlyUserRefreshOptions {
	store: MonthlyRefreshStore;
	token: string;
	now?: Date;
	targetMonth?: string;
	safeAfterUtc?: string;
	metrics?: readonly UserRefreshMetric[];
	limitPerMetric?: number;
	maxUsers?: number;
	ratePerHour?: number;
	maxRuntimeMs?: number;
	dryRun?: boolean;
	allowIncompleteMonth?: boolean;
	/**
	 * Never spend the token's GraphQL budget below this many points — pure headroom for live
	 * site traffic, which shares the same token. Only enforced when `fetchRateLimit` is supplied.
	 */
	remainingFloor?: number;
	/** How many users between budget polls. The poll itself costs 0 points. */
	pollEvery?: number;
	fetchRateLimit?: () => Promise<RateLimitBudget | null>;
	fetchMonthlyCommits: (
		login: string,
		token: string,
		windows: MonthWindow[],
	) => Promise<MonthlyCount[]>;
	sleep?: (ms: number) => Promise<void>;
	/** Runtime-budget clock only (may be a fake counter). Never use it for stored timestamps. */
	timeMs?: () => number;
	/**
	 * Wall clock for stored timestamps (`monthly_commits.fetched_at`, `entities.last_fetched`).
	 * Read per user rather than once per run, so a 2-hour pass doesn't stamp every row it touches
	 * with its startup time — that made the 2026-08-01 logs unreadable.
	 */
	clock?: () => Date;
	logger?: MonthlyRefreshLogger;
}

export interface MonthlyUserRefreshResult {
	status: "completed" | "locked" | "too_early" | "stopped";
	/** Why the run stopped early — only set when `status` is "stopped". */
	stopReason?: "max_runtime" | "rate_limit_floor";
	targetMonth: string;
	candidates: number;
	incompleteTargetMonth: number;
	skippedComplete: number;
	dryRunWouldRefresh: number;
	refreshed: number;
	failed: number;
	/** Logins GitHub no longer resolves. Marked and skipped from now on, not counted as failures. */
	unreachable: number;
	dryRun: boolean;
}

export function resolveTargetMonth(opts: {
	now: Date;
	safeAfterUtc: string;
}):
	| { ok: true; month: string }
	| { ok: false; reason: "too_early"; month: string; safeAt: string } {
	const safe = parseSafeAfterUtc(opts.safeAfterUtc);
	const monthStart = new Date(
		Date.UTC(opts.now.getUTCFullYear(), opts.now.getUTCMonth(), 1),
	);
	const safeAt = new Date(
		monthStart.getTime() + safe.minutesAfterMidnight * 60_000,
	);
	const target = monthLabel(
		new Date(
			Date.UTC(opts.now.getUTCFullYear(), opts.now.getUTCMonth() - 1, 1),
		),
	);

	if (opts.now.getUTCDate() === 1 && opts.now.getTime() < safeAt.getTime()) {
		return {
			ok: false,
			reason: "too_early",
			month: target,
			safeAt: safeAt.toISOString(),
		};
	}
	return { ok: true, month: target };
}

export async function runMonthlyUserRefresh(
	opts: RunMonthlyUserRefreshOptions,
): Promise<MonthlyUserRefreshResult> {
	const now = opts.now ?? new Date();
	const dryRun = opts.dryRun ?? false;
	const logger = opts.logger ?? quietLogger;
	const metrics = opts.metrics ?? USER_REFRESH_METRICS;
	const limitPerMetric = positiveInteger(
		opts.limitPerMetric ?? 500,
		"limitPerMetric",
	);
	const maxUsers =
		opts.maxUsers == null
			? undefined
			: positiveInteger(opts.maxUsers, "maxUsers");
	const ratePerHour = positiveInteger(opts.ratePerHour ?? 1000, "ratePerHour");
	const remainingFloor = positiveInteger(
		opts.remainingFloor ?? 500,
		"remainingFloor",
	);
	const pollEvery = positiveInteger(opts.pollEvery ?? 25, "pollEvery");
	const safeAfterUtc = opts.safeAfterUtc ?? "03:00";
	const sleep = opts.sleep ?? defaultSleep;
	const timeMs = opts.timeMs ?? Date.now;
	const clock = opts.clock ?? (() => new Date());
	const startedAt = timeMs();
	const target = opts.targetMonth
		? normalizeTargetMonth(opts.targetMonth)
		: resolveTargetMonth({ now, safeAfterUtc });

	if (typeof target !== "string" && !target.ok) {
		logger.info(
			`monthly-user-refresh startup target_month=${target.month} status=too_early safe_at=${target.safeAt}`,
		);
		return emptyResult("too_early", target.month, dryRun);
	}

	const targetMonth = typeof target === "string" ? target : target.month;
	const currentMonth = monthLabel(
		new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
	);
	if (!dryRun && !opts.allowIncompleteMonth && targetMonth >= currentMonth) {
		throw new Error(
			`Target month ${targetMonth} is not completed yet. The newest completed UTC month is before ${currentMonth}.`,
		);
	}
	const window = windowForMonth(targetMonth);
	const maxRuntimeMinutes = opts.maxRuntimeMs
		? Math.round(opts.maxRuntimeMs / 60_000)
		: "none";
	logger.info(
		`monthly-user-refresh startup target_month=${targetMonth} utc_now=${now.toISOString()} safe_after_utc=${safeAfterUtc} dry_run=${dryRun} allow_incomplete_month=${opts.allowIncompleteMonth ?? false} limit_per_metric=${limitPerMetric} max_users=${maxUsers ?? "none"} rate_per_hour=${ratePerHour} remaining_floor=${opts.fetchRateLimit ? remainingFloor : "unenforced"} poll_every=${pollEvery} max_runtime_minutes=${maxRuntimeMinutes}`,
	);

	const locked = await opts.store.tryLock();
	if (!locked) {
		logger.warn(
			`monthly-user-refresh target_month=${targetMonth} status=locked lock=held_elsewhere`,
		);
		return emptyResult("locked", targetMonth, dryRun);
	}

	const result = emptyResult("completed", targetMonth, dryRun);
	/** Remaining wall-clock before the max-runtime guard trips, or Infinity when unbounded. */
	const runtimeLeftMs = () =>
		opts.maxRuntimeMs ? opts.maxRuntimeMs - (timeMs() - startedAt) : Infinity;
	const budget = createBudgetGuard({
		remainingFloor,
		pollEvery,
		fetchRateLimit: opts.fetchRateLimit,
		sleep,
		nowMs: timeMs,
		runtimeLeftMs,
		logger,
		targetMonth,
	});

	try {
		const candidates = (
			await candidateUnion(opts.store, metrics, limitPerMetric)
		).slice(0, maxUsers);
		result.candidates = candidates.length;
		result.incompleteTargetMonth = await opts.store.countIncompleteMonth(
			candidates.map((c) => c.id),
			targetMonth,
		);
		logger.info(
			`monthly-user-refresh target_month=${targetMonth} candidates=${candidates.length} incomplete_target_month=${result.incompleteTargetMonth}`,
		);

		for (const candidate of candidates) {
			if (
				opts.maxRuntimeMs &&
				runtimeLeftMs() <= 0 &&
				result.refreshed + result.failed + result.dryRunWouldRefresh > 0
			) {
				result.status = "stopped";
				result.stopReason = "max_runtime";
				logger.warn(
					`monthly-user-refresh target_month=${targetMonth} status=stopped reason=max_runtime`,
				);
				break;
			}

			if (await opts.store.hasCompleteMonth(candidate.id, targetMonth)) {
				result.skippedComplete += 1;
				continue;
			}

			if (dryRun) {
				result.dryRunWouldRefresh += 1;
				logger.info(
					`monthly-user-refresh target_month=${targetMonth} login=${candidate.login} status=dry_run`,
				);
				continue;
			}

			// Stay above the reserved floor *before* spending a request, not after.
			if (!(await budget.ensure())) {
				result.status = "stopped";
				result.stopReason = "rate_limit_floor";
				break;
			}

			const outcome = await refreshOne({
				candidate,
				token: opts.token,
				window,
				targetMonth,
				store: opts.store,
				fetchMonthlyCommits: opts.fetchMonthlyCommits,
				budget,
				logger,
				clock,
			});
			if (outcome === "refreshed") result.refreshed += 1;
			else if (outcome === "unreachable") result.unreachable += 1;
			else result.failed += 1;

			await sleep((1 / ratePerHour) * 3_600_000);
		}
	} finally {
		await opts.store.releaseLock();
	}

	logger.info(
		`monthly-user-refresh done target_month=${targetMonth} status=${result.status}${result.stopReason ? ` reason=${result.stopReason}` : ""} candidates=${result.candidates} incomplete_target_month=${result.incompleteTargetMonth} refreshed=${result.refreshed} skipped_complete=${result.skippedComplete} failed=${result.failed} unreachable=${result.unreachable} dry_run_would_refresh=${result.dryRunWouldRefresh}`,
	);
	return result;
}

interface BudgetGuard {
	/** True to proceed; false when the run must stop rather than dip below the floor. */
	ensure(force?: boolean): Promise<boolean>;
	/** Account for a request that was just spent, between polls. */
	spend(): void;
}

/**
 * Keeps the run above `remainingFloor` GraphQL points. The token is shared with live traffic, so
 * a batch job that drains the hourly quota takes the site down with it. Polling costs nothing but
 * a round-trip, so we poll every `pollEvery` users and decrement locally in between.
 *
 * Below the floor the only options are "wait for the window to reset" or "stop". Waiting is
 * allowed only if it fits inside the remaining max-runtime budget: a scheduled job that sleeps
 * past its window is worse than one that exits 0 and leaves the month for the next pass, since a
 * missing month row *is* the retry queue.
 */
function createBudgetGuard(opts: {
	remainingFloor: number;
	pollEvery: number;
	fetchRateLimit?: () => Promise<RateLimitBudget | null>;
	sleep: (ms: number) => Promise<void>;
	nowMs: () => number;
	runtimeLeftMs: () => number;
	logger: MonthlyRefreshLogger;
	targetMonth: string;
}): BudgetGuard {
	const { fetchRateLimit, logger, targetMonth } = opts;
	// A GraphQL window is an hour, so two waits is already a long-running scheduled job. Past
	// that, stop and let the next scheduled pass pick up the still-missing months.
	const MAX_RESET_WAITS = 2;
	let remaining: number | null = null;
	let sincePoll = Number.POSITIVE_INFINITY; // force a poll before the first request
	let waits = 0;

	return {
		spend() {
			if (remaining != null) remaining -= 1;
			sincePoll += 1;
		},

		async ensure(force = false) {
			if (!fetchRateLimit) return true;
			// The local decrement is only trusted while it stays clear of the floor; once it gets
			// close we re-poll for the real number rather than guessing in either direction.
			const nearFloorLocally =
				remaining != null && remaining <= opts.remainingFloor;
			if (!force && !nearFloorLocally && sincePoll < opts.pollEvery)
				return true;

			const budget = await fetchRateLimit();
			sincePoll = 0;
			if (!budget) {
				// The poll itself failed. Don't invent a budget; let the request try and fail.
				logger.warn(
					`monthly-user-refresh target_month=${targetMonth} status=budget_poll_failed`,
				);
				return true;
			}
			remaining = budget.remaining;
			if (remaining > opts.remainingFloor) return true;

			const waitMs = new Date(budget.resetAt).getTime() - opts.nowMs() + 1_000;
			const runtimeLeft = opts.runtimeLeftMs();
			if (!Number.isFinite(waitMs) || waitMs <= 0) return true;
			if (waitMs > runtimeLeft || waits >= MAX_RESET_WAITS) {
				logger.warn(
					`monthly-user-refresh target_month=${targetMonth} status=stopped reason=rate_limit_floor remaining=${remaining} floor=${opts.remainingFloor} reset_at=${budget.resetAt} wait_ms=${waitMs} runtime_left_ms=${Math.max(0, Math.round(runtimeLeft))}`,
				);
				return false;
			}
			waits += 1;
			logger.warn(
				`monthly-user-refresh target_month=${targetMonth} status=waiting reason=rate_limit_floor remaining=${remaining} floor=${opts.remainingFloor} reset_at=${budget.resetAt} wait_ms=${waitMs} wait=${waits}/${MAX_RESET_WAITS}`,
			);
			await opts.sleep(waitMs);
			remaining = null; // window reset; re-poll on the next ensure()
			sincePoll = Number.POSITIVE_INFINITY;
			return true;
		},
	};
}

async function candidateUnion(
	store: MonthlyRefreshStore,
	metrics: readonly UserRefreshMetric[],
	limit: number,
): Promise<RefreshCandidate[]> {
	const buckets: RefreshCandidate[][] = [];
	for (const metric of metrics)
		buckets.push(await store.usersForMetric(metric, limit));

	const byId = new Map<string, RefreshCandidate>();
	for (let index = 0; index < limit; index++) {
		for (const bucket of buckets) {
			const row = bucket[index];
			if (!row) continue;
			if (!byId.has(row.id)) byId.set(row.id, row);
		}
	}
	return [...byId.values()];
}

type RefreshOutcome = "refreshed" | "unreachable" | "failed";

/**
 * A login GitHub can't resolve any more (deleted, renamed, blocked). `github.ts` already maps the
 * GraphQL "Could not resolve to a User" error to status 404, so this is a structural check — the
 * worker deliberately keeps no runtime dependency on that module (tests replace the fetcher
 * wholesale), hence duck-typing rather than `instanceof GitHubError`.
 */
function isMissingUser(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"status" in err &&
		(err as { status: unknown }).status === 404
	);
}

async function refreshOne(opts: {
	candidate: RefreshCandidate;
	token: string;
	window: MonthWindow;
	targetMonth: string;
	store: MonthlyRefreshStore;
	fetchMonthlyCommits: (
		login: string,
		token: string,
		windows: MonthWindow[],
	) => Promise<MonthlyCount[]>;
	budget: BudgetGuard;
	logger: MonthlyRefreshLogger;
	clock: () => Date;
}): Promise<RefreshOutcome> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			opts.budget.spend();
			const counts = (
				await opts.fetchMonthlyCommits(opts.candidate.login, opts.token, [
					opts.window,
				])
			)[0];
			// No counts means the fetcher returned nothing for a window it did not reject. Writing
			// zeros here would look like a successful refresh and permanently blank the month, so
			// treat it as a failure and leave the month incomplete for the next pass.
			if (!counts) throw new Error("no counts returned for the target month");
			const fetchedAt = opts.clock();
			await opts.store.upsertMonth(
				opts.candidate.id,
				opts.targetMonth,
				counts,
				fetchedAt,
			);
			const totals = await opts.store.recomputeTotals(
				opts.candidate.id,
				fetchedAt,
			);
			opts.logger.info(
				`monthly-user-refresh target_month=${opts.targetMonth} login=${opts.candidate.login} status=refreshed commits=${totals.commits} total=${totalContributions(totals)}`,
			);
			return "refreshed";
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A login that no longer resolves will never resolve on a retry, and a missing month row
			// is the retry queue — so without this marker one dead account fails every pass of every
			// month forever. Mark it and move on; a later successful lookup clears the flag.
			if (isMissingUser(err)) {
				await opts.store.markUnreachable(opts.candidate.id, opts.clock());
				opts.logger.warn(
					`monthly-user-refresh target_month=${opts.targetMonth} login=${opts.candidate.login} status=unreachable error=${JSON.stringify(message)}`,
				);
				return "unreachable";
			}
			if (attempt === 1) {
				opts.logger.warn(
					`monthly-user-refresh target_month=${opts.targetMonth} login=${opts.candidate.login} status=retrying error=${JSON.stringify(message)}`,
				);
				// The failure may BE the rate limit. Re-poll the real budget (and wait for the
				// window to reset if we're under the floor) instead of immediately spending
				// another request into a wall.
				if (!(await opts.budget.ensure(true))) {
					opts.logger.error(
						`monthly-user-refresh target_month=${opts.targetMonth} login=${opts.candidate.login} status=failed reason=rate_limit_floor`,
					);
					return "failed";
				}
				continue;
			}
			opts.logger.error(
				`monthly-user-refresh target_month=${opts.targetMonth} login=${opts.candidate.login} status=failed error=${JSON.stringify(message)}`,
			);
			return "failed";
		}
	}
	return "failed";
}

function windowForMonth(month: string): MonthWindow {
	const [year, monthNumber] = monthParts(month);
	const from = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0));
	const to = new Date(Date.UTC(year, monthNumber, 0, 23, 59, 59));
	return { from: from.toISOString(), to: to.toISOString(), label: month };
}

function normalizeTargetMonth(month: string): string {
	const [year, monthNumber] = monthParts(month);
	return `${year}-${String(monthNumber).padStart(2, "0")}-01`;
}

function monthParts(month: string): [number, number] {
	const match = /^(\d{4})-(\d{2})-01$/.exec(month);
	if (!match)
		throw new Error(`Invalid target month "${month}". Use YYYY-MM-01.`);
	const year = Number(match[1]);
	const monthNumber = Number(match[2]);
	if (monthNumber < 1 || monthNumber > 12) {
		throw new Error(`Invalid target month "${month}". Use YYYY-MM-01.`);
	}
	return [year, monthNumber];
}

function monthLabel(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function parseSafeAfterUtc(value: string): { minutesAfterMidnight: number } {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match)
		throw new Error(`Invalid safe-after UTC time "${value}". Use HH:MM.`);
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) {
		throw new Error(`Invalid safe-after UTC time "${value}". Use HH:MM.`);
	}
	return { minutesAfterMidnight: hours * 60 + minutes };
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value;
}

function totalContributions(counts: MonthlyCount): number {
	return (
		counts.commits +
		counts.restricted +
		counts.issues +
		counts.pullRequests +
		counts.reviews +
		counts.repos
	);
}

function emptyResult(
	status: MonthlyUserRefreshResult["status"],
	targetMonth: string,
	dryRun: boolean,
): MonthlyUserRefreshResult {
	return {
		status,
		targetMonth,
		candidates: 0,
		incompleteTargetMonth: 0,
		skippedComplete: 0,
		dryRunWouldRefresh: 0,
		refreshed: 0,
		failed: 0,
		unreachable: 0,
		dryRun,
	};
}

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

const quietLogger: MonthlyRefreshLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};
