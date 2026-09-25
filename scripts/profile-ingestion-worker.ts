import { eq } from "drizzle-orm";
import { db } from "#/lib/db";
import { entities, profileNetworkMembers } from "#/lib/db/schema";
import { fetchFollowing } from "#/lib/github-following";
import { fetchProfileByNodeId } from "#/lib/github";
import { runProfileIngestion } from "#/lib/profile-ingestion";
import { backfillProfileNetwork } from "#/lib/profile-network-backfill";
import {
	createProfileIngestionBoss,
	createProfileIngestionQueue,
	PROFILE_INGESTION_DEAD_LETTER_QUEUE_NAME,
	PROFILE_INGESTION_QUEUE_NAME,
} from "#/lib/profile-ingestion-queue";
import { createProfileNetworkDiscovery } from "#/lib/profile-network-discovery";
import { claimNetworkDiscovery } from "#/lib/profile-network-capacity";
import {
	createProfileNetworkBoss,
	createProfileNetworkQueue,
	PROFILE_NETWORK_DEAD_QUEUE_NAME,
	PROFILE_NETWORK_QUEUE_NAME,
} from "#/lib/profile-network-queue";
import { createProfileNetworkDiscoveryStore } from "#/lib/profile-network-store";
import {
	createJobOutcomeRecorder,
	type JobOutcomeRecorder,
	observeQueues,
	readQueueSnapshots,
} from "#/lib/queue-telemetry";
import { withGitHubSource } from "#/lib/telemetry";
import { startTelemetry } from "#/lib/telemetry-node";

const connectionString = process.env.DATABASE_URL;
const token = process.env.GITHUB_TOKEN;
if (!connectionString) throw new Error("DATABASE_URL is required.");
if (!token) throw new Error("GITHUB_TOKEN is required.");
if (!db) throw new Error("Database client failed to initialise.");
const database = db;

const boss = createProfileIngestionBoss(connectionString);
const queue = createProfileIngestionQueue(boss);
const networkBoss = createProfileNetworkBoss(connectionString);
const networkQueue = createProfileNetworkQueue(networkBoss);
const discoverProfileNetwork = createProfileNetworkDiscovery({
	store: createProfileNetworkDiscoveryStore(database),
	admit: async (nodeId, following) => {
		const [owner] = await database
			.select({ id: entities.id })
			.from(entities)
			.where(eq(entities.githubNodeId, nodeId))
			.limit(1);
		if (!owner) throw new Error(`Network owner ${nodeId} is not tracked.`);
		return (
			await claimNetworkDiscovery(
				database,
				owner.id,
				following,
				new Date(),
				true,
			)
		).admission;
	},
	resolveOwner: async (nodeId, token) => {
		const owner = await fetchProfileByNodeId(nodeId, token);
		return { login: owner.login, following: owner.following };
	},
	fetchFollowing,
});
let stopping = false;
let startup: Promise<void> | undefined;
let backfillTimer: ReturnType<typeof setInterval> | undefined;

// No-op unless an OTLP endpoint is configured.
const telemetry = startTelemetry({
	serviceName: "commit-history-worker",
	defaultSource: "profile-worker",
});
let recordJob: JobOutcomeRecorder = () => {};
if (telemetry.meter) {
	observeQueues(
		telemetry.meter,
		// The final export on shutdown runs after pg-boss has stopped; skip the read then.
		async () =>
			stopping
				? []
				: readQueueSnapshots(boss, database, [
						PROFILE_INGESTION_QUEUE_NAME,
						PROFILE_INGESTION_DEAD_LETTER_QUEUE_NAME,
						PROFILE_NETWORK_QUEUE_NAME,
						PROFILE_NETWORK_DEAD_QUEUE_NAME,
					]),
		(error) =>
			console.warn(
				`profile-ingestion-worker status=queue_metrics_error error=${JSON.stringify(String(error))}`,
			),
	);
	recordJob = createJobOutcomeRecorder(telemetry.meter);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => void shutdown(signal));
}

boss.on("error", (error) => {
	console.error(
		`profile-ingestion-worker status=queue_error error=${JSON.stringify(String(error))}`,
	);
});
boss.on("warning", (warning) => {
	console.warn(
		`profile-ingestion-worker status=queue_warning warning=${JSON.stringify(warning)}`,
	);
});
networkBoss.on("error", (error) => {
	console.error(
		`profile-network-worker status=queue_error error=${JSON.stringify(String(error))}`,
	);
});
networkBoss.on("warning", (warning) => {
	console.warn(
		`profile-network-worker status=queue_warning warning=${JSON.stringify(String(warning))}`,
	);
});

startup = Promise.all([queue.start(), networkQueue.start()]).then(() => undefined);
await startup;

// A signal may arrive while pg-boss is starting. Shutdown then owns the connections, and no new
// work registration may happen after stop has begun.
if (!stopping) {
	await queue.work(async (job, signal) => {
		const startedAt = Date.now();
		console.log(
			`profile-ingestion-worker status=started login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.githubNodeId)}`,
		);
		try {
			const result = await runProfileIngestion(
				{ login: job.login, githubNodeId: job.githubNodeId },
				{
					token,
					// One queued profile at a time, and one GitHub GraphQL request at a time within
					// that profile. Interactive lookups keep their latency-oriented bounded default.
					monthlyRequestConcurrency: 1,
					remainingFloor: numberFromEnv(
						"PROFILE_INGESTION_REMAINING_FLOOR",
						500,
					),
					signal,
				},
			);
			if (result.status === "deferred") {
				await queue.defer(job, result.retryAt);
			}
			if (result.status === "unreachable" && !result.history) {
				await database
					.update(profileNetworkMembers)
					.set({ unavailableAt: new Date() })
					.where(eq(profileNetworkMembers.memberGithubNodeId, job.githubNodeId));
			} else if (
				result.status === "complete" ||
				(result.status === "unreachable" && result.history)
			) {
				await database
					.update(profileNetworkMembers)
					.set({ unavailableAt: null })
					.where(eq(profileNetworkMembers.memberGithubNodeId, job.githubNodeId));
			}
			recordJob(PROFILE_INGESTION_QUEUE_NAME, result.status, Date.now() - startedAt);
			console.log(
				`profile-ingestion-worker status=${result.status} login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.githubNodeId)} duration_ms=${Date.now() - startedAt}`,
			);
			return result;
		} catch (error) {
			recordJob(PROFILE_INGESTION_QUEUE_NAME, "failed", Date.now() - startedAt);
			console.error(
				`profile-ingestion-worker status=failed login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.githubNodeId)} duration_ms=${Date.now() - startedAt} error=${JSON.stringify(String(error))}`,
			);
			throw error;
		}
	});
	await networkQueue.work(async (job, signal) => {
		const startedAt = Date.now();
		console.log(
			`profile-network-worker status=started login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.ownerGithubNodeId)}`,
		);
		try {
			const result = await withGitHubSource("network-discovery", () =>
				discoverProfileNetwork(job, { token, signal }),
			);
			recordJob(PROFILE_NETWORK_QUEUE_NAME, "completed", Date.now() - startedAt);
			console.log(
				`profile-network-worker status=completed login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.ownerGithubNodeId)} members=${result.membersFound} enqueued=${result.profilesEnqueued} duration_ms=${Date.now() - startedAt}`,
			);
			return result;
		} catch (error) {
			if (String(error).includes("Network discovery is paused while the ingestion queue is busy.")) {
				await networkQueue.defer(job, new Date(Date.now() + 5 * 60_000));
				recordJob(PROFILE_NETWORK_QUEUE_NAME, "deferred", Date.now() - startedAt);
				console.log(`profile-network-worker status=deferred login=${JSON.stringify(job.login)} reason=profile_queue_busy`);
				return { membersFound: 0, profilesEnqueued: 0 };
			}
			recordJob(PROFILE_NETWORK_QUEUE_NAME, "failed", Date.now() - startedAt);
			console.error(
				`profile-network-worker status=failed login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.ownerGithubNodeId)} duration_ms=${Date.now() - startedAt} error=${JSON.stringify(String(error))}`,
			);
			throw error;
		}
	});
	// The saved cursor lets the worker resume after a restart and keeps large networks moving
	// even after the visitor leaves the page. At most one pass runs in this process at a time.
	let backfillRunning = false;
	backfillTimer = setInterval(() => {
		if (stopping || backfillRunning) return;
		backfillRunning = true;
		void backfillProfileNetwork(database, queue)
			.then((result) => {
				if (result.enqueued || result.completed) {
					console.log(`profile-network-worker status=backfill examined=${result.examined} enqueued=${result.enqueued} completed=${result.completed}`);
				}
			})
			.catch((error) => {
				console.error(`profile-network-worker status=backfill_error error=${JSON.stringify(String(error))}`);
			})
			.finally(() => { backfillRunning = false; });
	}, 5_000);
	console.log(
		"profile-ingestion-worker status=ready ingestion_concurrency=1 network_concurrency=1",
	);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
	if (stopping) return;
	stopping = true;
	if (backfillTimer) clearInterval(backfillTimer);
	console.log(`profile-ingestion-worker status=stopping signal=${signal}`);
	let exitCode = 0;
	try {
		// Do not race PgBoss.start() with stop() when the platform terminates during startup.
		await startup?.catch(() => {});
		await Promise.all([queue.stop(), networkQueue.stop()]);
	} catch (error) {
		exitCode = 1;
		console.error(
			`profile-ingestion-worker status=shutdown_error error=${JSON.stringify(String(error))}`,
		);
	} finally {
		// Flush the final export while the pool can still answer the queue gauges.
		await telemetry.shutdown();
		await database.$client.end({ timeout: 5 }).catch(() => {});
	}
	console.log(`profile-ingestion-worker status=stopped code=${exitCode}`);
	process.exitCode = exitCode;
}

function numberFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative integer.`);
	}
	return parsed;
}
