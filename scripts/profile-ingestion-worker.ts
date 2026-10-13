import { eq } from "drizzle-orm";
import { db } from "#/lib/db";
import { entities, profileNetworkMembers } from "#/lib/db/schema";
import { runCurrentMonthRefresh } from "#/lib/current-month";
import {
	CURRENT_MONTH_CRON,
	createCurrentMonthBoss,
	createCurrentMonthQueue,
	planCurrentMonthFollowUp,
} from "#/lib/current-month-queue";
import { createCurrentMonthStore } from "#/lib/current-month-store";
import { fetchFollowing } from "#/lib/github-following";
import {
	fetchOrgMemberContributions,
	fetchOrgMembers,
	fetchMonthlyCommits,
	fetchOrgProfile,
	fetchProfileByNodeId,
	fetchRateLimitBudget,
	GitHubError,
	monthToDateWindow,
	yearlyWindows,
} from "#/lib/github";
import {
	createMonthlyRefreshBoss,
	createMonthlyRefreshQueue,
	MONTHLY_REFRESH_CRON,
	planMonthlyRefreshFollowUp,
} from "#/lib/monthly-refresh-queue";
import { runMonthlyUserRefresh } from "#/lib/monthly-user-refresh";
import { createMonthlyUserRefreshStore } from "#/lib/monthly-user-refresh-store";
import { runOrgRefresh } from "#/lib/org-refresh";
import {
	createOrgRefreshBoss,
	createOrgRefreshQueue,
} from "#/lib/org-refresh-queue";
import { createOrgRefreshStore } from "#/lib/org-refresh-store";
import { runProfileIngestion } from "#/lib/profile-ingestion";
import { backfillProfileNetwork } from "#/lib/profile-network-backfill";
import {
	createProfileIngestionBoss,
	createProfileIngestionQueue,
} from "#/lib/profile-ingestion-queue";
import {
	createProfileNetworkDiscovery,
	NetworkDiscoveryDeferred,
} from "#/lib/profile-network-discovery";
import { claimNetworkDiscovery } from "#/lib/profile-network-capacity";
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
// Two budget tiers on the one shared token. Work someone is looking at right now (network
// discovery for a viewed leaderboard, a viewed org's refresh) may spend down to the reserved floor.
// Backfill profiles arrived only through someone's network, so they stop much earlier and leave
// the rest of each hour to viewed orgs and live lookups (which run inline in the web process).
const remainingFloor = numberFromEnv("PROFILE_INGESTION_REMAINING_FLOOR", 500);
const backfillFloor = Math.max(
	remainingFloor,
	numberFromEnv("NETWORK_BACKFILL_REMAINING_FLOOR", 2000),
);
// One org-refresh slice: small enough that no org monopolises the worker (microsoft is ~9k
// requests), and re-queued behind other orgs until nothing is due.
const ORG_SLICE_REQUESTS = 200;
const ORG_SLICE_RUNTIME_MS = 10 * 60_000;
const RATE_LIMITED_RETRY_MS = 5 * 60_000;
// One monthly-refresh slice. The cohort (~2k users at 1,000/hour) takes a couple of hours, so it
// runs as a chain of slices that each survive a deploy, rather than one multi-hour process.
const MONTHLY_SLICE_RUNTIME_MS = 10 * 60_000;
// One slice of the daily current-month pass (~1.2k users, one request each).
const CURRENT_MONTH_SLICE_RUNTIME_MS = 10 * 60_000;

const boss = createProfileIngestionBoss(connectionString);
const queue = createProfileIngestionQueue(boss);
const networkBoss = createProfileNetworkBoss(connectionString);
const networkQueue = createProfileNetworkQueue(networkBoss);
const orgBoss = createOrgRefreshBoss(connectionString);
const orgQueue = createOrgRefreshQueue(orgBoss);
const orgStore = createOrgRefreshStore(database);
const monthlyBoss = createMonthlyRefreshBoss(connectionString);
const monthlyQueue = createMonthlyRefreshQueue(monthlyBoss);
const monthlyStore = createMonthlyUserRefreshStore(database);
const currentMonthBoss = createCurrentMonthBoss(connectionString);
const currentMonthQueue = createCurrentMonthQueue(currentMonthBoss);
const currentMonthStore = createCurrentMonthStore(database);
const discoverProfileNetwork = createProfileNetworkDiscovery({
	store: createProfileNetworkDiscoveryStore(database),
	admit: async (nodeId) => {
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
				null,
				new Date(),
				true,
			)
		).admission;
	},
	budgetDeferral: async (token) => {
		const budget = await fetchRateLimitBudget(token);
		// The poll is rejected once the token is exhausted; treat unknown as "not now".
		if (!budget) return new Date(Date.now() + 5 * 60_000);
		if (budget.remaining > remainingFloor) return null;
		return new Date(budget.resetAt);
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
// Every pg-boss instance needs an error listener: an unhandled 'error' event kills the process,
// and a brief database stall at the top of the hour is enough to emit one.
orgBoss.on("error", (error) => {
	console.error(
		`org-refresh-worker status=queue_error error=${JSON.stringify(String(error))}`,
	);
});
monthlyBoss.on("error", (error) => {
	console.error(
		`monthly-refresh-worker status=queue_error error=${JSON.stringify(String(error))}`,
	);
});
currentMonthBoss.on("error", (error) => {
	console.error(
		`current-month-worker status=queue_error error=${JSON.stringify(String(error))}`,
	);
});
networkBoss.on("warning", (warning) => {
	console.warn(
		`profile-network-worker status=queue_warning warning=${JSON.stringify(String(warning))}`,
	);
});

startup = Promise.all([
	queue.start(),
	networkQueue.start(),
	// Self-provisioning: the org queue is new, and creating it is idempotent.
	orgQueue.start({ provision: true }),
	// Owns the cron that used to be three Coolify scheduled tasks.
	monthlyQueue.start({ provision: true, schedule: true }),
	currentMonthQueue.start({ provision: true, schedule: true }),
]).then(() => undefined);
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
					remainingFloor: backfillFloor,
					signal,
				},
			);
			if (result.status === "deferred") {
				await queue.defer(job, notBeforeSoon(result.retryAt));
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
			// The budget poll can pass and the request still be refused: visitor lookups have no floor
			// and spend the last points first, around the hourly reset. Backfill waits instead of
			// burning a retry.
			if (await isBudgetRefusal(error, token)) {
				const retryAt = new Date(Date.now() + RATE_LIMITED_RETRY_MS);
				await queue.defer(job, retryAt);
				console.log(
					`profile-ingestion-worker status=deferred reason=rate_limited login=${JSON.stringify(job.login)} node_id=${JSON.stringify(job.githubNodeId)} duration_ms=${Date.now() - startedAt}`,
				);
				return { status: "deferred", retryAt } as const;
			}
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
			if (error instanceof NetworkDiscoveryDeferred) {
				await networkQueue.defer(job, notBeforeSoon(error.retryAt));
				console.log(
					`profile-network-worker status=deferred login=${JSON.stringify(job.login)} reason=${error.reason}`,
				);
				return { membersFound: 0, profilesEnqueued: 0 };
			}
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
	await orgQueue.work(async (job) => {
		const startedAt = Date.now();
		const result = await runOrgRefresh({
			store: orgStore,
			token,
			orgs: [job.login],
			maxRequests: ORG_SLICE_REQUESTS,
			maxEnumerations: 1,
			maxRuntimeMs: ORG_SLICE_RUNTIME_MS,
			remainingFloor,
			fetchRateLimit: () => fetchRateLimitBudget(token),
			fetchOrgProfile,
			fetchOrgMembers,
			fetchOrgMemberContributions,
			yearlyWindows,
			logger: console,
		});
		let next: string;
		if (result.status === "locked") {
			// The local CLI holds the lock; try again shortly.
			await orgQueue.request(job, new Date(Date.now() + 60_000));
			next = "locked_retry";
		} else if (
			result.stopReason === "rate_limit_floor" ||
			result.stopReason === "rate_limited"
		) {
			const budget = await fetchRateLimitBudget(token);
			await orgQueue.request(
				job,
				notBeforeSoon(
					budget
						? new Date(budget.resetAt)
						: new Date(Date.now() + 15 * 60_000),
				),
			);
			next = "after_reset";
		} else if (result.stopReason === "consecutive_failures") {
			// Let pg-boss retry with backoff rather than spinning on a systemic fault.
			throw new Error(`org refresh for ${job.login} failed repeatedly`);
		} else if (
			(result.dueRemaining ?? 0) > 0 &&
			(result.membersFetched > 0 || result.orgsEnumerated > 0)
		) {
			// Back of the line, so other viewed orgs get their slice in between. Requiring progress
			// stops a member that always fails from re-queueing the org forever.
			await orgQueue.request(job, new Date(Date.now() + 5_000));
			next = "next_slice";
		} else {
			next = "done";
		}
		console.log(
			`org-refresh-worker status=${next} login=${JSON.stringify(job.login)} members_fetched=${result.membersFetched} due_remaining=${result.dueRemaining ?? "unknown"} duration_ms=${Date.now() - startedAt}`,
		);
		return { next, dueRemaining: result.dueRemaining };
	});
	await monthlyQueue.work(async (job) => {
		const startedAt = Date.now();
		const result = await runMonthlyUserRefresh({
			store: monthlyStore,
			token,
			now: new Date(),
			targetMonth: job.targetMonth,
			maxRuntimeMs: MONTHLY_SLICE_RUNTIME_MS,
			remainingFloor,
			fetchRateLimit: () => fetchRateLimitBudget(token),
			fetchMonthlyCommits,
			logger: console,
		});
		const budget =
			result.stopReason === "rate_limit_floor"
				? await fetchRateLimitBudget(token)
				: null;
		const followUp = planMonthlyRefreshFollowUp(
			result,
			new Date(),
			budget ? new Date(budget.resetAt) : null,
		);
		if (followUp.next !== "done") await monthlyQueue.request(job, followUp.at);
		console.log(
			`monthly-refresh-worker status=${followUp.next} target_month=${result.targetMonth} refreshed=${result.refreshed} failed=${result.failed} unreachable=${result.unreachable} skipped_complete=${result.skippedComplete} duration_ms=${Date.now() - startedAt}`,
		);
		return { next: followUp.next, targetMonth: result.targetMonth };
	});
	// The daily pass is background work, so it stops at the backfill floor. Lookups read the
	// current month inline in the web process.
	await currentMonthQueue.workDaily(async () => {
		const startedAt = Date.now();
		const result = await runCurrentMonthRefresh({
			store: currentMonthStore,
			token,
			maxRuntimeMs: CURRENT_MONTH_SLICE_RUNTIME_MS,
			remainingFloor: backfillFloor,
			fetchRateLimit: () => fetchRateLimitBudget(token),
			// Strict: a window that keeps failing must not be stored as a zero month.
			fetchMonthlyCommits: (login, githubToken, windows) =>
				fetchMonthlyCommits(login, githubToken, windows, { strict: true }),
			monthToDateWindow,
			logger: console,
		});
		const budget =
			result.stopReason === "rate_limit_floor"
				? await fetchRateLimitBudget(token)
				: null;
		const followUp = planCurrentMonthFollowUp(
			result,
			new Date(),
			budget ? new Date(budget.resetAt) : null,
		);
		if (followUp.next !== "done") await currentMonthQueue.requestDaily(followUp.at);
		console.log(
			`current-month-worker status=${followUp.next} refreshed=${result.refreshed} skipped_fresh=${result.skippedFresh} failed=${result.failed} unreachable=${result.unreachable} duration_ms=${Date.now() - startedAt}`,
		);
		return { next: followUp.next };
	});
	console.log(
		`profile-ingestion-worker status=ready ingestion_concurrency=1 network_concurrency=1 org_concurrency=1 monthly_cron=${JSON.stringify(MONTHLY_REFRESH_CRON)} current_month_cron=${JSON.stringify(CURRENT_MONTH_CRON)} remaining_floor=${remainingFloor} backfill_floor=${backfillFloor}`,
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
		await Promise.all([
			queue.stop(),
			networkQueue.stop(),
			orgQueue.stop(),
			monthlyQueue.stop(),
			currentMonthQueue.stop(),
		]);
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

/**
 * A 403/429 that coincides with an exhausted (or unreadable) budget is the shared token running
 * dry, not something wrong with the job. Any other 403 still fails and retries normally, so a
 * permanently forbidden profile ends in the dead-letter queue instead of deferring forever.
 */
async function isBudgetRefusal(
	error: unknown,
	githubToken: string,
): Promise<boolean> {
	if (!(error instanceof GitHubError)) return false;
	if (error.status !== 403 && error.status !== 429) return false;
	const budget = await fetchRateLimitBudget(githubToken);
	return !budget || budget.remaining <= backfillFloor;
}

/**
 * GitHub's `resetAt` can already be in the past by the time a job defers (the window rolled over
 * mid-job), and the queues reject a deferral that isn't in the future. Retry shortly instead.
 */
function notBeforeSoon(retryAt: Date): Date {
	return new Date(Math.max(retryAt.getTime(), Date.now() + 30_000));
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
