import {
	type ConstructorOptions,
	PgBoss,
	type Queue,
	type UpdateQueueOptions,
} from "pg-boss";
import { isValidLogin } from "#/lib/github";

export const PROFILE_NETWORK_QUEUE_NAME = "profile-network-v1";
export const PROFILE_NETWORK_DEAD_QUEUE_NAME = "profile-network-dead-v1";

type QueueSettings = UpdateQueueOptions &
	Omit<Queue, "name" | "partition" | "policy">;

const DEAD_SETTINGS = {
	retryLimit: 0,
	retentionSeconds: 90 * 24 * 60 * 60,
	deleteAfterSeconds: 0,
} satisfies QueueSettings;

const NETWORK_SETTINGS = {
	retryLimit: 5,
	retryDelay: 60,
	retryBackoff: true,
	retryDelayMax: 60 * 60,
	expireInSeconds: 30 * 60,
	heartbeatSeconds: 60,
	retentionSeconds: 14 * 24 * 60 * 60,
	deleteAfterSeconds: 7 * 24 * 60 * 60,
	deadLetter: PROFILE_NETWORK_DEAD_QUEUE_NAME,
	warningQueueSize: 500,
} satisfies QueueSettings;

export interface ProfileNetworkJob {
	version: 1;
	ownerGithubNodeId: string;
	login: string;
}

export interface ProfileNetworkQueue {
	start(opts?: { provision?: boolean }): Promise<void>;
	request(job: ProfileNetworkJob): Promise<{
		jobId: string;
		disposition: "inserted" | "updated";
	}>;
	work(
		handler: (job: ProfileNetworkJob, signal: AbortSignal) => Promise<unknown>,
	): Promise<void>;
	stop(): Promise<void>;
}

export function createProfileNetworkBoss(
	connectionString: string,
	overrides: Partial<ConstructorOptions> = {},
): PgBoss {
	return new PgBoss({
		connectionString,
		max: 1,
		application_name: "commit-history-profile-network",
		useListenNotify: false,
		migrate: false,
		...overrides,
		createSchema: overrides.createSchema ?? overrides.migrate ?? false,
	});
}

/** Durable discovery intent, coalesced by the network owner's immutable GitHub identity. */
export function createProfileNetworkQueue(boss: PgBoss): ProfileNetworkQueue {
	return {
		async start(opts = {}) {
			await boss.start();
			if (opts.provision) await provisionProfileNetworkQueues(boss);
			if (!(await boss.getQueue(PROFILE_NETWORK_QUEUE_NAME))) {
				throw new Error(
					"Profile network queue is not provisioned; run profile:queue:migrate first.",
				);
			}
		},

		async request(job) {
			const payload = parseProfileNetworkJob(job);
			const result = await boss.upsert(PROFILE_NETWORK_QUEUE_NAME, payload, {
				singletonKey: payload.ownerGithubNodeId,
			});
			const jobId = result.jobs[0];
			if (!jobId) throw new Error("pg-boss did not return a network job id.");
			return {
				jobId,
				disposition: result.inserted === 1 ? "inserted" : "updated",
			};
		},

		async work(handler) {
			await boss.work<unknown>(
				PROFILE_NETWORK_QUEUE_NAME,
				{
					batchSize: 1,
					localConcurrency: 1,
					pollingIntervalSeconds: 2,
					heartbeatRefreshSeconds: 30,
				},
				async ([job]) => {
					if (!job)
						throw new Error("pg-boss delivered an empty network batch.");
					return handler(parseProfileNetworkJob(job.data), job.signal);
				},
			);
		},

		async stop() {
			await boss.stop({ graceful: true, timeout: 30_000 });
		},
	};
}

export async function provisionProfileNetworkQueues(boss: PgBoss) {
	await provisionQueue(
		boss,
		PROFILE_NETWORK_DEAD_QUEUE_NAME,
		"standard",
		DEAD_SETTINGS,
	);
	await provisionQueue(
		boss,
		PROFILE_NETWORK_QUEUE_NAME,
		"stately",
		NETWORK_SETTINGS,
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

export function parseProfileNetworkJob(value: unknown): ProfileNetworkJob {
	if (!value || typeof value !== "object") {
		throw new Error("Profile network payload must be an object.");
	}
	const payload = value as Record<string, unknown>;
	if (payload.version !== 1) {
		throw new Error("Unsupported profile network payload version.");
	}
	if (
		typeof payload.ownerGithubNodeId !== "string" ||
		!payload.ownerGithubNodeId.trim() ||
		payload.ownerGithubNodeId.length > 255
	) {
		throw new Error("Profile network payload has an invalid owner node id.");
	}
	if (
		typeof payload.login !== "string" ||
		!isValidLogin(payload.login.trim())
	) {
		throw new Error("Profile network payload has an invalid GitHub login.");
	}
	return {
		version: 1,
		ownerGithubNodeId: payload.ownerGithubNodeId.trim(),
		login: payload.login.trim(),
	};
}
