import { eq } from "drizzle-orm";
import { db } from "#/lib/db";
import { profileNetworkMembers } from "#/lib/db/schema";
import { fetchFollowing } from "#/lib/github-following";
import { runProfileIngestion } from "#/lib/profile-ingestion";
import {
	createProfileIngestionBoss,
	createProfileIngestionQueue,
} from "#/lib/profile-ingestion-queue";
import { createProfileNetworkDiscovery } from "#/lib/profile-network-discovery";
import {
	createProfileNetworkBoss,
	createProfileNetworkQueue,
} from "#/lib/profile-network-queue";
import { createProfileNetworkDiscoveryStore } from "#/lib/profile-network-store";

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
	fetchFollowing,
	requestIngestion: (job) => queue.request(job),
});
let stopping = false;
let startup: Promise<void> | undefined;

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
			console.log(
				`profile-ingestion-worker status=${result.status} login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.githubNodeId)} duration_ms=${Date.now() - startedAt}`,
			);
			return result;
		} catch (error) {
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
			const result = await discoverProfileNetwork(job, { token, signal });
			console.log(
				`profile-network-worker status=completed login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.ownerGithubNodeId)} members=${result.membersFound} enqueued=${result.profilesEnqueued} duration_ms=${Date.now() - startedAt}`,
			);
			return result;
		} catch (error) {
			console.error(
				`profile-network-worker status=failed login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.ownerGithubNodeId)} duration_ms=${Date.now() - startedAt} error=${JSON.stringify(String(error))}`,
			);
			throw error;
		}
	});
	console.log(
		"profile-ingestion-worker status=ready ingestion_concurrency=1 network_concurrency=1",
	);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
	if (stopping) return;
	stopping = true;
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
