/**
 * Shared plumbing for the background workers that run as Coolify scheduled tasks
 * (`.output/worker/*.mjs`, see the Dockerfile). Extracted from monthly-user-refresh once a second
 * job needed the same three guarantees:
 *
 *   1. one run at a time (Postgres advisory lock),
 *   2. never drain the shared GitHub token below a reserved floor,
 *   3. stop cleanly at a wall-clock cap instead of being killed by the task timeout.
 *
 * Every job here is expected to be *resumable off its own data* — a missing row is the retry queue —
 * so stopping early is normal and cheap, and exiting 0 with work left over is a success.
 */

import type { DB } from "#/lib/db";
import type { RateLimitBudget } from "#/lib/github";

export interface JobLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export const quietLogger: JobLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

export const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value;
}

export function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer.`);
	}
	return value;
}

export interface JobLock {
	tryLock(): Promise<boolean>;
	releaseLock(): Promise<void>;
}

/**
 * Session-scoped advisory lock pinned to one reserved connection.
 *
 * `database.execute` takes an arbitrary connection out of the postgres.js pool, and unlocking from
 * a different connection than the one holding the lock silently returns false. Mutual exclusion
 * would work either way (a second process is a second session), but a release that quietly no-ops
 * is a trap, so the connection is held for the run's lifetime and released in `releaseLock`.
 *
 * Keys must be unique per job — see the LOCK_KEYS table below.
 */
export function createJobLock(
	database: DB,
	key1: number,
	key2: number,
	label: string,
): JobLock {
	let lockConn: Awaited<ReturnType<DB["$client"]["reserve"]>> | null = null;

	return {
		async tryLock() {
			lockConn = await database.$client.reserve();
			const [row] = await lockConn<Array<{ acquired: boolean }>>`
				select pg_try_advisory_lock(${key1}, ${key2}) as acquired`;
			const acquired = Boolean(row?.acquired);
			if (!acquired) {
				lockConn.release();
				lockConn = null;
			}
			return acquired;
		},

		async releaseLock() {
			if (!lockConn) return;
			try {
				const [row] = await lockConn<Array<{ released: boolean }>>`
					select pg_advisory_unlock(${key1}, ${key2}) as released`;
				if (!row?.released) {
					console.warn(
						`${label} lock=release_returned_false (was it held by this session?)`,
					);
				}
			} finally {
				lockConn.release();
				lockConn = null;
			}
		},
	};
}

/**
 * Advisory-lock keys, one row per background job. Same first key, distinct second — collisions
 * would make two unrelated jobs exclude each other, which is much harder to notice than a job
 * that never runs.
 */
export const LOCK_KEYS = {
	monthlyUserRefresh: [20260701, 1],
	orgBackfill: [20260701, 2],
} as const;

export interface BudgetGuard {
	/** True to proceed; false when the run must stop rather than dip below the floor. */
	ensure(force?: boolean): Promise<boolean>;
	/** Account for requests just spent, between polls. */
	spend(requests?: number): void;
	/** Total requests this guard has been told about — the run's spend estimate. */
	spent(): number;
}

/**
 * Keeps a run above `remainingFloor` GraphQL points. The token is shared with live site traffic, so
 * a batch job that drains the hourly quota takes the site down with it. Polling costs nothing but a
 * round-trip, so we poll every `pollEvery` requests and decrement locally in between.
 *
 * Below the floor the only options are "wait for the window to reset" or "stop". Waiting is allowed
 * only if it fits inside the remaining max-runtime budget: a scheduled job that sleeps past its
 * window is worse than one that exits 0 and leaves the rest for the next pass.
 */
export function createBudgetGuard(opts: {
	/** Log prefix, e.g. `org-backfill` — every line is `<label> status=…`. */
	label: string;
	remainingFloor: number;
	pollEvery: number;
	fetchRateLimit?: () => Promise<RateLimitBudget | null>;
	sleep: (ms: number) => Promise<void>;
	nowMs: () => number;
	runtimeLeftMs: () => number;
	logger: JobLogger;
}): BudgetGuard {
	const { fetchRateLimit, logger, label } = opts;
	// A GraphQL window is an hour, so two waits is already a long-running scheduled job. Past that,
	// stop and let the next scheduled pass pick up what's still missing.
	const MAX_RESET_WAITS = 2;
	let remaining: number | null = null;
	let sincePoll = Number.POSITIVE_INFINITY; // force a poll before the first request
	let waits = 0;
	let total = 0;

	return {
		spend(requests = 1) {
			if (remaining != null) remaining -= requests;
			sincePoll += requests;
			total += requests;
		},

		spent() {
			return total;
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
				logger.warn(`${label} status=budget_poll_failed`);
				return true;
			}
			remaining = budget.remaining;
			if (remaining > opts.remainingFloor) return true;

			const waitMs = new Date(budget.resetAt).getTime() - opts.nowMs() + 1_000;
			const runtimeLeft = opts.runtimeLeftMs();
			if (!Number.isFinite(waitMs) || waitMs <= 0) return true;
			if (waitMs > runtimeLeft || waits >= MAX_RESET_WAITS) {
				logger.warn(
					`${label} status=stopped reason=rate_limit_floor remaining=${remaining} floor=${opts.remainingFloor} reset_at=${budget.resetAt} wait_ms=${waitMs} runtime_left_ms=${Math.max(0, Math.round(runtimeLeft))}`,
				);
				return false;
			}
			waits += 1;
			logger.warn(
				`${label} status=waiting reason=rate_limit_floor remaining=${remaining} floor=${opts.remainingFloor} reset_at=${budget.resetAt} wait_ms=${waitMs} wait=${waits}/${MAX_RESET_WAITS}`,
			);
			await opts.sleep(waitMs);
			remaining = null; // window reset; re-poll on the next ensure()
			sincePoll = Number.POSITIVE_INFINITY;
			return true;
		},
	};
}
