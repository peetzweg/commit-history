import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProfileIngestionBoss,
	createProfileIngestionQueue,
	PROFILE_INGESTION_QUEUE_NAME,
	type ProfileIngestionJob,
	provisionProfileIngestionQueues,
} from "#/lib/profile-ingestion-queue";

const connectionString = process.env.PROFILE_INGESTION_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration("profile ingestion queue on Postgres", () => {
	const schema = `pgboss_test_${randomUUID().replaceAll("-", "")}`;
	const sqlClient = connectionString
		? postgres(connectionString, { prepare: false, max: 2 })
		: null;
	const database = sqlClient ? drizzle(sqlClient) : null;
	const boss = connectionString
		? createProfileIngestionBoss(connectionString, { schema, migrate: true })
		: null;
	const queue = boss ? createProfileIngestionQueue(boss) : null;

	beforeAll(async () => {
		await queue?.start({ provision: true });
	});

	afterAll(async () => {
		await queue?.stop();
		if (sqlClient) {
			await sqlClient.unsafe(`drop schema if exists "${schema}" cascade`);
			await sqlClient.end({ timeout: 5 });
		}
	});

	it("coalesces repeated requests for the same GitHub identity", async () => {
		const job: ProfileIngestionJob = {
			version: 1,
			githubNodeId: "U_queue_coalesce",
			login: "first-login",
		};

		const first = await queue?.request(job);
		const second = await queue?.request({ ...job, login: "current-login" });

		expect(first).toMatchObject({ disposition: "inserted" });
		expect(second).toMatchObject({
			disposition: "updated",
			jobId: first?.jobId,
		});
	});

	it("keeps one follow-up request while the same identity is active", async () => {
		const job: ProfileIngestionJob = {
			version: 1,
			githubNodeId: "U_queue_active_followup",
			login: "active-login",
		};
		const first = await queue?.request(job);
		const [active] =
			(await boss?.fetch<ProfileIngestionJob>(PROFILE_INGESTION_QUEUE_NAME)) ??
			[];

		expect(active?.id).toBe(first?.jobId);

		const followUp = await queue?.request({ ...job, login: "renamed-login" });
		const repeated = await queue?.request({ ...job, login: "latest-login" });

		expect(followUp).toMatchObject({ disposition: "inserted" });
		expect(followUp?.jobId).not.toBe(first?.jobId);
		expect(repeated).toMatchObject({
			disposition: "updated",
			jobId: followUp?.jobId,
		});
		await expect(
			boss?.findJobs<ProfileIngestionJob>(PROFILE_INGESTION_QUEUE_NAME, {
				key: job.githubNodeId,
				queued: true,
			}),
		).resolves.toMatchObject([
			{ id: followUp?.jobId, data: { login: "latest-login" } },
		]);

		if (active) await boss?.complete(PROFILE_INGESTION_QUEUE_NAME, active.id);
	});

	it("restores mutable queue settings when provisioning is repeated", async () => {
		await boss?.updateQueue(PROFILE_INGESTION_QUEUE_NAME, {
			retryLimit: 1,
			retryDelay: 1,
			retryBackoff: false,
			retentionSeconds: 60,
			warningQueueSize: 1,
		});
		if (boss) await provisionProfileIngestionQueues(boss);

		await expect(
			boss?.getQueue(PROFILE_INGESTION_QUEUE_NAME),
		).resolves.toMatchObject({
			policy: "stately",
			retryLimit: 5,
			retryDelay: 60,
			retryBackoff: true,
			retryDelayMax: 60 * 60,
			expireInSeconds: 6 * 60 * 60,
			heartbeatSeconds: 60,
			retentionSeconds: 14 * 24 * 60 * 60,
			deleteAfterSeconds: 7 * 24 * 60 * 60,
			warningQueueSize: 500,
		});
	});

	it("does not enqueue when the surrounding application transaction rolls back", async () => {
		const job: ProfileIngestionJob = {
			version: 1,
			githubNodeId: "U_queue_rollback",
			login: "rollback",
		};

		await expect(
			database?.transaction(async (tx) => {
				await queue?.request(job, { transaction: tx });
				throw new Error("rollback tracer");
			}),
		).rejects.toThrow("rollback tracer");

		await expect(queue?.request(job)).resolves.toMatchObject({
			disposition: "inserted",
		});
	});
});
