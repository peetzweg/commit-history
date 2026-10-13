import {
	type ConstructorOptions,
	PgBoss,
	type Queue,
	type UpdateQueueOptions,
} from "pg-boss";
import type { CurrentMonthRefreshResult } from "#/lib/current-month";

export const CURRENT_MONTH_DAILY_QUEUE_NAME = "current-month-daily-v1";
export const CURRENT_MONTH_DEAD_QUEUE_NAME = "current-month-dead-v1";

/**
 * Daily at 05:00 UTC: clear of the 03:00 database backup and the 04:00 monthly refresh, which on
 * the 1st–3rd should get the token first.
 */
export const CURRENT_MONTH_CRON = "0 5 * * *";

const DAILY_SINGLETON_KEY = "daily";

type QueueSettings = UpdateQueueOptions &
	Omit<Queue, "name" | "partition" | "policy">;

const DEAD_SETTINGS = {
	retryLimit: 0,
	retentionSeconds: 30 * 24 * 60 * 60,
	deleteAfterSeconds: 0,
} satisfies QueueSettings;

const DAILY_SETTINGS = {
	retryLimit: 3,
	retryDelay: 5 * 60,
	retryBackoff: true,
	retryDelayMax: 60 * 60,
	// One slice is bounded by the worker's runtime cap, well inside this.
	expireInSeconds: 30 * 60,
	heartbeatSeconds: 60,
	retentionSeconds: 7 * 24 * 60 * 60,
	deleteAfterSeconds: 14 * 24 * 60 * 60,
	deadLetter: CURRENT_MONTH_DEAD_QUEUE_NAME,
} satisfies QueueSettings;

/** One slice of the daily pass over the top of every board. */
export interface CurrentMonthDailyJob {
	version: 1;
}

export interface CurrentMonthQueue {
	start(opts?: { provision?: boolean; schedule?: boolean }): Promise<void>;
	requestDaily(startAfter?: Date): Promise<void>;
	workDaily(
		handler: (job: CurrentMonthDailyJob) => Promise<unknown>,
	): Promise<void>;
	stop(): Promise<void>;
}

export function createCurrentMonthBoss(
	connectionString: string,
	overrides: Partial<ConstructorOptions> = {},
): PgBoss {
	return new PgBoss({
		connectionString,
		max: 1,
		application_name: "commit-history-current-month",
		useListenNotify: false,
		migrate: false,
		...overrides,
		createSchema: overrides.createSchema ?? overrides.migrate ?? false,
	});
}

export function createCurrentMonthQueue(boss: PgBoss): CurrentMonthQueue {
	return {
		async start(opts = {}) {
			await boss.start();
			if (opts.provision) await provisionCurrentMonthQueues(boss);
			if (!(await boss.getQueue(CURRENT_MONTH_DAILY_QUEUE_NAME))) {
				throw new Error(
					"Current-month queue is not provisioned; start the worker or run profile:queue:migrate first.",
				);
			}
			// Idempotent: the stored schedule is replaced, so a changed cron ships with a deploy.
			if (opts.schedule) {
				await boss.schedule(
					CURRENT_MONTH_DAILY_QUEUE_NAME,
					CURRENT_MONTH_CRON,
					{ version: 1 } satisfies CurrentMonthDailyJob,
					{ tz: "UTC", singletonKey: DAILY_SINGLETON_KEY },
				);
			}
		},

		async requestDaily(startAfter) {
			await boss.upsert(
				CURRENT_MONTH_DAILY_QUEUE_NAME,
				{ version: 1 } satisfies CurrentMonthDailyJob,
				{
					singletonKey: DAILY_SINGLETON_KEY,
					...(startAfter ? { startAfter } : {}),
				},
			);
		},

		async workDaily(handler) {
			await boss.work<unknown>(
				CURRENT_MONTH_DAILY_QUEUE_NAME,
				{
					batchSize: 1,
					localConcurrency: 1,
					pollingIntervalSeconds: 30,
					heartbeatRefreshSeconds: 30,
				},
				async ([job]) => {
					if (!job) throw new Error("pg-boss delivered an empty batch.");
					if ((job.data as { version?: unknown })?.version !== 1) {
						throw new Error("Unsupported current-month payload version.");
					}
					return handler({ version: 1 });
				},
			);
		},

		async stop() {
			await boss.stop({ graceful: true, timeout: 30_000 });
		},
	};
}

export async function provisionCurrentMonthQueues(boss: PgBoss) {
	await provisionQueue(
		boss,
		CURRENT_MONTH_DEAD_QUEUE_NAME,
		"standard",
		DEAD_SETTINGS,
	);
	await provisionQueue(
		boss,
		CURRENT_MONTH_DAILY_QUEUE_NAME,
		"stately",
		DAILY_SETTINGS,
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

export type CurrentMonthFollowUp =
	| { next: "done" }
	| { next: "next_slice" | "locked_retry" | "after_reset"; at: Date };

/** What the worker does after a daily slice; same shape as the monthly refresh's planner. */
export function planCurrentMonthFollowUp(
	result: Pick<CurrentMonthRefreshResult, "status" | "stopReason">,
	now: Date,
	resetAt: Date | null,
): CurrentMonthFollowUp {
	const nowMs = now.getTime();
	if (result.status === "locked") {
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
