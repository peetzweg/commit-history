import {
	type ConstructorOptions,
	PgBoss,
	type Queue,
	type UpdateQueueOptions,
} from "pg-boss";
import type { MonthlyUserRefreshResult } from "#/lib/monthly-user-refresh";

export const MONTHLY_REFRESH_QUEUE_NAME = "monthly-user-refresh-v1";
export const MONTHLY_REFRESH_DEAD_QUEUE_NAME = "monthly-user-refresh-dead-v1";

/**
 * Fires on the 1st, 2nd and 3rd at 04:00 UTC: after the 03:00 database backup, and the two
 * extra days replace the old Coolify retry tasks. Once the month is complete a run is a cheap,
 * DB-only no-op, so the repeats only ever pick up what an earlier day left behind.
 */
export const MONTHLY_REFRESH_CRON = "0 4 1-3 * *";

/** One key for every job: the cron firing and slice continuations coalesce into a single job. */
const SINGLETON_KEY = "monthly";

type QueueSettings = UpdateQueueOptions &
	Omit<Queue, "name" | "partition" | "policy">;

const DEAD_SETTINGS = {
	retryLimit: 0,
	retentionSeconds: 90 * 24 * 60 * 60,
	deleteAfterSeconds: 0,
} satisfies QueueSettings;

const MONTHLY_REFRESH_SETTINGS = {
	retryLimit: 3,
	retryDelay: 5 * 60,
	retryBackoff: true,
	retryDelayMax: 60 * 60,
	// One slice is bounded by the worker's runtime cap, well inside this.
	expireInSeconds: 30 * 60,
	heartbeatSeconds: 60,
	retentionSeconds: 14 * 24 * 60 * 60,
	deleteAfterSeconds: 30 * 24 * 60 * 60,
	deadLetter: MONTHLY_REFRESH_DEAD_QUEUE_NAME,
} satisfies QueueSettings;

/**
 * "Bring the leaderboard cohort up to the last completed month." `targetMonth` is only set for a
 * deliberate backfill; the scheduled job leaves it out and the engine picks the newest completed
 * month at run time.
 */
export interface MonthlyRefreshJob {
	version: 1;
	targetMonth?: string;
}

export interface MonthlyRefreshQueue {
	start(opts?: { provision?: boolean; schedule?: boolean }): Promise<void>;
	request(job: MonthlyRefreshJob, startAfter?: Date): Promise<void>;
	work(handler: (job: MonthlyRefreshJob) => Promise<unknown>): Promise<void>;
	stop(): Promise<void>;
}

export function createMonthlyRefreshBoss(
	connectionString: string,
	overrides: Partial<ConstructorOptions> = {},
): PgBoss {
	return new PgBoss({
		connectionString,
		max: 1,
		application_name: "commit-history-monthly-refresh",
		useListenNotify: false,
		migrate: false,
		...overrides,
		createSchema: overrides.createSchema ?? overrides.migrate ?? false,
	});
}

export function createMonthlyRefreshQueue(boss: PgBoss): MonthlyRefreshQueue {
	return {
		async start(opts = {}) {
			await boss.start();
			if (opts.provision) await provisionMonthlyRefreshQueues(boss);
			if (!(await boss.getQueue(MONTHLY_REFRESH_QUEUE_NAME))) {
				throw new Error(
					"Monthly refresh queue is not provisioned; start the worker or run profile:queue:migrate first.",
				);
			}
			// Idempotent: re-running replaces the stored schedule, so a changed cron ships with a
			// deploy instead of living in a dashboard.
			if (opts.schedule) {
				await boss.schedule(
					MONTHLY_REFRESH_QUEUE_NAME,
					MONTHLY_REFRESH_CRON,
					{ version: 1 } satisfies MonthlyRefreshJob,
					{ tz: "UTC", singletonKey: SINGLETON_KEY },
				);
			}
		},

		async request(job, startAfter) {
			const payload = parseMonthlyRefreshJob(job);
			await boss.upsert(MONTHLY_REFRESH_QUEUE_NAME, payload, {
				singletonKey: SINGLETON_KEY,
				...(startAfter ? { startAfter } : {}),
			});
		},

		async work(handler) {
			await boss.work<unknown>(
				MONTHLY_REFRESH_QUEUE_NAME,
				{
					batchSize: 1,
					localConcurrency: 1,
					pollingIntervalSeconds: 30,
					heartbeatRefreshSeconds: 30,
				},
				async ([job]) => {
					if (!job)
						throw new Error(
							"pg-boss delivered an empty monthly refresh batch.",
						);
					return handler(parseMonthlyRefreshJob(job.data));
				},
			);
		},

		async stop() {
			await boss.stop({ graceful: true, timeout: 30_000 });
		},
	};
}

export async function provisionMonthlyRefreshQueues(boss: PgBoss) {
	await provisionQueue(
		boss,
		MONTHLY_REFRESH_DEAD_QUEUE_NAME,
		"standard",
		DEAD_SETTINGS,
	);
	await provisionQueue(
		boss,
		MONTHLY_REFRESH_QUEUE_NAME,
		"stately",
		MONTHLY_REFRESH_SETTINGS,
	);
}

async function provisionQueue(
	boss: PgBoss,
	name: string,
	policy: NonNullable<Queue["policy"]>,
	settings: QueueSettings,
) {
	await boss.createQueue(name, { policy, ...settings });
	const installed = await boss.getQueue(name);
	if (!installed) throw new Error(`Queue ${name} was not provisioned.`);
	if (installed.policy !== policy) {
		throw new Error(
			`Queue ${name} uses immutable policy ${installed.policy}; expected ${policy}.`,
		);
	}
	await boss.updateQueue(name, settings);
}

export function parseMonthlyRefreshJob(value: unknown): MonthlyRefreshJob {
	if (!value || typeof value !== "object") {
		throw new Error("Monthly refresh payload must be an object.");
	}
	const payload = value as Record<string, unknown>;
	if (payload.version !== 1) {
		throw new Error("Unsupported monthly refresh payload version.");
	}
	if (payload.targetMonth == null) return { version: 1 };
	if (
		typeof payload.targetMonth !== "string" ||
		!/^\d{4}-\d{2}-01$/.test(payload.targetMonth)
	) {
		throw new Error("Monthly refresh targetMonth must be YYYY-MM-01.");
	}
	return { version: 1, targetMonth: payload.targetMonth };
}

export type MonthlyRefreshFollowUp =
	| { next: "done" }
	| { next: "next_slice" | "locked_retry" | "after_reset"; at: Date };

/**
 * What the worker does after one slice. Only a slice that stopped on a cap continues; a completed
 * pass is done even with failures, which the next scheduled day (or next month) picks up, so a
 * user who always fails can never keep the job spinning.
 */
export function planMonthlyRefreshFollowUp(
	result: Pick<MonthlyUserRefreshResult, "status" | "stopReason">,
	now: Date,
	resetAt: Date | null,
): MonthlyRefreshFollowUp {
	const nowMs = now.getTime();
	if (result.status === "locked") {
		// The local CLI holds the lock; try again shortly.
		return { next: "locked_retry", at: new Date(nowMs + 60_000) };
	}
	if (result.status === "stopped" && result.stopReason === "rate_limit_floor") {
		const fallback = nowMs + 15 * 60_000;
		const at = Math.max(resetAt?.getTime() ?? fallback, nowMs + 30_000);
		return { next: "after_reset", at: new Date(at) };
	}
	if (result.status === "stopped") {
		return { next: "next_slice", at: new Date(nowMs + 5_000) };
	}
	return { next: "done" };
}
