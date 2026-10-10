import {
	type ConstructorOptions,
	PgBoss,
	type Queue,
	type UpdateQueueOptions,
} from "pg-boss";
import { isValidLogin } from "#/lib/github";

export const ORG_REFRESH_QUEUE_NAME = "org-refresh-v1";
export const ORG_REFRESH_DEAD_QUEUE_NAME = "org-refresh-dead-v1";

type QueueSettings = UpdateQueueOptions &
	Omit<Queue, "name" | "partition" | "policy">;

const DEAD_SETTINGS = {
	retryLimit: 0,
	retentionSeconds: 90 * 24 * 60 * 60,
	deleteAfterSeconds: 0,
} satisfies QueueSettings;

const ORG_REFRESH_SETTINGS = {
	retryLimit: 5,
	retryDelay: 60,
	retryBackoff: true,
	retryDelayMax: 60 * 60,
	// One slice is bounded by the worker's request and runtime caps, well inside this.
	expireInSeconds: 30 * 60,
	heartbeatSeconds: 60,
	retentionSeconds: 14 * 24 * 60 * 60,
	deleteAfterSeconds: 7 * 24 * 60 * 60,
	deadLetter: ORG_REFRESH_DEAD_QUEUE_NAME,
	warningQueueSize: 500,
} satisfies QueueSettings;

/** "Bring this org up to the last completed month." Coalesced per org, so repeat views are free. */
export interface OrgRefreshJob {
	version: 1;
	login: string;
}

export interface OrgRefreshQueue {
	start(opts?: { provision?: boolean }): Promise<void>;
	/** Queue a slice now (or after `startAfter`). An already-waiting job for the org absorbs it. */
	request(job: OrgRefreshJob, startAfter?: Date): Promise<void>;
	work(
		handler: (job: OrgRefreshJob, signal: AbortSignal) => Promise<unknown>,
	): Promise<void>;
	stop(): Promise<void>;
}

export function createOrgRefreshBoss(
	connectionString: string,
	overrides: Partial<ConstructorOptions> = {},
): PgBoss {
	return new PgBoss({
		connectionString,
		max: 1,
		application_name: "commit-history-org-refresh",
		useListenNotify: false,
		migrate: false,
		...overrides,
		createSchema: overrides.createSchema ?? overrides.migrate ?? false,
	});
}

export function createOrgRefreshQueue(boss: PgBoss): OrgRefreshQueue {
	return {
		async start(opts = {}) {
			await boss.start();
			if (opts.provision) await provisionOrgRefreshQueues(boss);
			if (!(await boss.getQueue(ORG_REFRESH_QUEUE_NAME))) {
				throw new Error(
					"Org refresh queue is not provisioned; start the worker or run profile:queue:migrate first.",
				);
			}
		},

		async request(job, startAfter) {
			const payload = parseOrgRefreshJob(job);
			await boss.upsert(ORG_REFRESH_QUEUE_NAME, payload, {
				singletonKey: payload.login.toLowerCase(),
				...(startAfter ? { startAfter } : {}),
			});
		},

		async work(handler) {
			await boss.work<unknown>(
				ORG_REFRESH_QUEUE_NAME,
				{
					batchSize: 1,
					localConcurrency: 1,
					pollingIntervalSeconds: 5,
					heartbeatRefreshSeconds: 30,
				},
				async ([job]) => {
					if (!job)
						throw new Error("pg-boss delivered an empty org refresh batch.");
					return handler(parseOrgRefreshJob(job.data), job.signal);
				},
			);
		},

		async stop() {
			await boss.stop({ graceful: true, timeout: 30_000 });
		},
	};
}

export async function provisionOrgRefreshQueues(boss: PgBoss) {
	await provisionQueue(
		boss,
		ORG_REFRESH_DEAD_QUEUE_NAME,
		"standard",
		DEAD_SETTINGS,
	);
	await provisionQueue(
		boss,
		ORG_REFRESH_QUEUE_NAME,
		"stately",
		ORG_REFRESH_SETTINGS,
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

export function parseOrgRefreshJob(value: unknown): OrgRefreshJob {
	if (!value || typeof value !== "object") {
		throw new Error("Org refresh payload must be an object.");
	}
	const payload = value as Record<string, unknown>;
	if (payload.version !== 1) {
		throw new Error("Unsupported org refresh payload version.");
	}
	if (
		typeof payload.login !== "string" ||
		!isValidLogin(payload.login.trim())
	) {
		throw new Error("Org refresh payload has an invalid GitHub login.");
	}
	return { version: 1, login: payload.login.trim() };
}
