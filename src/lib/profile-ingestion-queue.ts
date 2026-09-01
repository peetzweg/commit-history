import { sql } from "drizzle-orm";
import {
	type ConstructorOptions,
	type DrizzleTransactionLike,
	fromDrizzle,
	PgBoss,
	type Queue,
	type UpdateQueueOptions,
} from "pg-boss";
import { isValidLogin } from "#/lib/github";
import type { ProfileIngestionResult } from "#/lib/profile-ingestion";

export const PROFILE_INGESTION_QUEUE_NAME = "profile-ingestion-v1";
export const PROFILE_INGESTION_DEAD_LETTER_QUEUE_NAME =
	"profile-ingestion-dead-v1";

type ProvisionedQueueSettings = UpdateQueueOptions &
	Omit<Queue, "name" | "partition" | "policy">;

const DEAD_LETTER_QUEUE_SETTINGS = {
	retryLimit: 0,
	retentionSeconds: 90 * 24 * 60 * 60,
	deleteAfterSeconds: 0,
} satisfies ProvisionedQueueSettings;

const PROFILE_INGESTION_QUEUE_SETTINGS = {
	retryLimit: 5,
	retryDelay: 60,
	retryBackoff: true,
	retryDelayMax: 60 * 60,
	expireInSeconds: 6 * 60 * 60,
	heartbeatSeconds: 60,
	retentionSeconds: 14 * 24 * 60 * 60,
	deleteAfterSeconds: 7 * 24 * 60 * 60,
	deadLetter: PROFILE_INGESTION_DEAD_LETTER_QUEUE_NAME,
	warningQueueSize: 500,
} satisfies ProvisionedQueueSettings;

/** The durable queue contract; versioning belongs to the transport rather than the ingestion core. */
export interface ProfileIngestionJob {
	version: 1;
	githubNodeId: string;
	login: string;
}

export interface ProfileIngestionRequestOptions {
	transaction?: DrizzleTransactionLike;
}

export interface ProfileIngestionRequestResult {
	jobId: string;
	disposition: "inserted" | "updated";
}

export interface ProfileIngestionQueue {
	start(opts?: { provision?: boolean }): Promise<void>;
	request(
		job: ProfileIngestionJob,
		opts?: ProfileIngestionRequestOptions,
	): Promise<ProfileIngestionRequestResult>;
	defer(
		job: ProfileIngestionJob,
		retryAt: Date,
	): Promise<ProfileIngestionRequestResult>;
	work(
		handler: (
			job: ProfileIngestionJob,
			signal: AbortSignal,
		) => Promise<ProfileIngestionResult>,
	): Promise<void>;
	stop(): Promise<void>;
}

/** A bounded pg-boss pool. Polling is deliberate; no session-pinned LISTEN connection is needed. */
export function createProfileIngestionBoss(
	connectionString: string,
	overrides: Partial<ConstructorOptions> = {},
): PgBoss {
	return new PgBoss({
		connectionString,
		max: 2,
		application_name: "commit-history-profile-ingestion",
		useListenNotify: false,
		migrate: false,
		...overrides,
		createSchema: overrides.createSchema ?? overrides.migrate ?? false,
	});
}

/**
 * Durable producer/consumer seam. Queue names, coalescing, retries, heartbeat and retention are
 * intentionally fixed here so callers only express an application ingestion intent.
 */
export function createProfileIngestionQueue(
	boss: PgBoss,
): ProfileIngestionQueue {
	async function upsert(
		job: ProfileIngestionJob,
		opts: ProfileIngestionRequestOptions & { startAfter?: Date },
	): Promise<ProfileIngestionRequestResult> {
		const payload = parseProfileIngestionJob(job);
		const result = await boss.upsert(PROFILE_INGESTION_QUEUE_NAME, payload, {
			singletonKey: payload.githubNodeId,
			...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
			...(opts.transaction ? { db: fromDrizzle(opts.transaction, sql) } : {}),
		});
		const jobId = result.jobs[0];
		if (!jobId) throw new Error("pg-boss did not return an ingestion job id.");
		return {
			jobId,
			disposition: result.inserted === 1 ? "inserted" : "updated",
		};
	}

	return {
		async start(opts = {}) {
			await boss.start();
			if (opts.provision) {
				await provisionProfileIngestionQueues(boss);
			}
			const installed = await boss.getQueue(PROFILE_INGESTION_QUEUE_NAME);
			if (!installed) {
				throw new Error(
					"Profile ingestion queue is not provisioned; run profile:queue:migrate first.",
				);
			}
		},

		async request(job, opts = {}) {
			return upsert(job, opts);
		},

		async defer(job, retryAt) {
			if (retryAt.getTime() <= Date.now()) {
				throw new Error("Deferred ingestion must be scheduled in the future.");
			}
			return upsert(job, { startAfter: retryAt });
		},

		async work(handler) {
			await boss.work<unknown>(
				PROFILE_INGESTION_QUEUE_NAME,
				{
					batchSize: 1,
					localConcurrency: 1,
					pollingIntervalSeconds: 2,
					heartbeatRefreshSeconds: 30,
				},
				async ([job]) => {
					if (!job)
						throw new Error("pg-boss delivered an empty ingestion batch.");
					return handler(parseProfileIngestionJob(job.data), job.signal);
				},
			);
		},

		async stop() {
			await boss.stop({ graceful: true, timeout: 30_000 });
		},
	};
}

/**
 * Installs the fixed queue contract. pg-boss cannot change a queue's policy after creation, so a
 * policy mismatch requires a versioned queue migration. All mutable settings are deliberately
 * refreshed on every run so a redeploy does not silently retain stale retry or retention values.
 */
export async function provisionProfileIngestionQueues(
	boss: PgBoss,
): Promise<void> {
	await provisionQueue(
		boss,
		PROFILE_INGESTION_DEAD_LETTER_QUEUE_NAME,
		"standard",
		DEAD_LETTER_QUEUE_SETTINGS,
	);
	await provisionQueue(
		boss,
		PROFILE_INGESTION_QUEUE_NAME,
		"stately",
		PROFILE_INGESTION_QUEUE_SETTINGS,
	);
}

async function provisionQueue(
	boss: PgBoss,
	name: string,
	policy: NonNullable<Queue["policy"]>,
	settings: ProvisionedQueueSettings,
): Promise<void> {
	await boss.createQueue(name, { policy, ...settings });
	const installed = await boss.getQueue(name);
	if (!installed) throw new Error(`Queue ${name} was not provisioned.`);
	if (installed.policy !== policy) {
		throw new Error(
			`Queue ${name} uses immutable policy ${installed.policy}; expected ${policy}. Provision a versioned queue instead.`,
		);
	}
	await boss.updateQueue(name, settings);
}

export function parseProfileIngestionJob(value: unknown): ProfileIngestionJob {
	if (!value || typeof value !== "object") {
		throw new Error("Profile ingestion payload must be an object.");
	}
	const payload = value as Record<string, unknown>;
	if (payload.version !== 1) {
		throw new Error("Unsupported profile ingestion payload version.");
	}
	if (
		typeof payload.githubNodeId !== "string" ||
		!payload.githubNodeId.trim() ||
		payload.githubNodeId.length > 255
	) {
		throw new Error("Profile ingestion payload has an invalid GitHub node id.");
	}
	if (
		typeof payload.login !== "string" ||
		!isValidLogin(payload.login.trim())
	) {
		throw new Error("Profile ingestion payload has an invalid GitHub login.");
	}
	return {
		version: 1,
		githubNodeId: payload.githubNodeId.trim(),
		login: payload.login.trim(),
	};
}
