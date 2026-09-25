/**
 * Queue-health metrics for the profile worker (#202). NODE-ONLY, like `telemetry-node.ts`.
 *
 * Counts are read straight from pg-boss's job table at export time (every 60s by default) rather
 * than from its hourly-refreshed queue cache, so a stuck backlog shows up within a minute. The
 * metrics carry only the queue name and job state: never a login, node ID or job ID.
 */
import type { Meter } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { DB } from "#/lib/db";

export interface QueueSnapshot {
	queue: string;
	/** Runnable now (`created`/`retry` with `start_after` in the past). */
	ready: number;
	/** Scheduled for later: rate-limit deferrals and retry backoff. */
	deferred: number;
	/** Waiting on another attempt after a failure (a subset of ready + deferred). */
	retry: number;
	active: number;
	/** Retained failed jobs. Bounded by the queue's retention, so a rolling count. */
	failed: number;
	/** Age of the oldest runnable job, 0 when nothing is runnable. */
	oldestReadyAgeSeconds: number;
}

// pg-boss names its tables itself, but the name is interpolated as an identifier, so it must
// still pass a strict check before it reaches SQL.
const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

export async function readQueueSnapshots(
	boss: PgBoss,
	database: DB,
	queueNames: readonly string[],
): Promise<QueueSnapshot[]> {
	const snapshots: QueueSnapshot[] = [];
	for (const name of queueNames) {
		const queue = await boss.getQueue(name);
		if (!queue || !TABLE_RE.test(queue.table)) continue;
		const [row] = await database.execute<{
			ready: number;
			deferred: number;
			retry: number;
			active: number;
			failed: number;
			oldest: number | null;
		}>(sql`
			select
				count(*) filter (where state in ('created', 'retry') and start_after <= now())::int as ready,
				count(*) filter (where state in ('created', 'retry') and start_after > now())::int as deferred,
				count(*) filter (where state = 'retry')::int as retry,
				count(*) filter (where state = 'active')::int as active,
				count(*) filter (where state = 'failed')::int as failed,
				extract(epoch from now() - min(created_on) filter (
					where state in ('created', 'retry') and start_after <= now()
				))::float8 as oldest
			from pgboss.${sql.raw(queue.table)}
			where name = ${name}
		`);
		snapshots.push({
			queue: name,
			ready: row?.ready ?? 0,
			deferred: row?.deferred ?? 0,
			retry: row?.retry ?? 0,
			active: row?.active ?? 0,
			failed: row?.failed ?? 0,
			oldestReadyAgeSeconds: Math.max(0, row?.oldest ?? 0),
		});
	}
	return snapshots;
}

/**
 * Register queue gauges plus a `worker.up` liveness gauge. `worker.up` is reported on every export
 * while the process runs, so its absence (not a zero) is what signals a dead worker.
 */
export function observeQueues(
	meter: Meter,
	read: () => Promise<QueueSnapshot[]>,
	onError: (error: unknown) => void,
): void {
	const jobs = meter.createObservableGauge("queue.jobs", {
		description: "Jobs per queue and state.",
	});
	const oldest = meter.createObservableGauge("queue.oldest_ready_age", {
		description: "Age of the oldest runnable job.",
		unit: "s",
	});
	meter.addBatchObservableCallback(
		async (result) => {
			let snapshots: QueueSnapshot[];
			try {
				snapshots = await read();
			} catch (error) {
				// A failed read skips one sample; it must not take the rest of the export down.
				onError(error);
				return;
			}
			for (const s of snapshots) {
				for (const state of [
					"ready",
					"deferred",
					"retry",
					"active",
					"failed",
				] as const) {
					result.observe(jobs, s[state], { queue: s.queue, state });
				}
				result.observe(oldest, s.oldestReadyAgeSeconds, { queue: s.queue });
			}
		},
		[jobs, oldest],
	);
	meter
		.createObservableGauge("worker.up", {
			description: "1 while the worker process is running.",
		})
		.addCallback((result) => result.observe(1));
}

export type JobOutcomeRecorder = (
	queue: string,
	outcome: string,
	durationMs: number,
) => void;

/** Job duration histogram; its `_count` doubles as completion/failure throughput by outcome. */
export function createJobOutcomeRecorder(meter: Meter): JobOutcomeRecorder {
	const duration = meter.createHistogram("queue.job.duration", {
		description: "Handler duration per finished job, by outcome.",
		unit: "s",
		advice: {
			explicitBucketBoundaries: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
		},
	});
	return (queue, outcome, durationMs) =>
		duration.record(durationMs / 1000, { queue, outcome });
}
