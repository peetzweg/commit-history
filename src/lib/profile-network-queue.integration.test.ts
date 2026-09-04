import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProfileNetworkBoss,
	createProfileNetworkQueue,
} from "#/lib/profile-network-queue";

const connectionString = process.env.PROFILE_INGESTION_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration("profile network queue on Postgres", () => {
	const schema = `pn_test_${randomUUID().replaceAll("-", "")}`;
	const cleanup = connectionString
		? postgres(connectionString, { prepare: false, max: 1 })
		: null;
	const boss = connectionString
		? createProfileNetworkBoss(connectionString, { schema, migrate: true })
		: null;
	const queue = boss ? createProfileNetworkQueue(boss) : null;

	beforeAll(async () => {
		await queue?.start({ provision: true });
	});

	afterAll(async () => {
		await queue?.stop();
		if (cleanup) {
			await cleanup.unsafe(`drop schema if exists "${schema}" cascade`);
			await cleanup.end({ timeout: 5 });
		}
	});

	it("coalesces repeated discovery requests for one immutable owner", async () => {
		const first = await queue?.request({
			version: 1,
			ownerGithubNodeId: "U_owner",
			login: "old-login",
		});
		const second = await queue?.request({
			version: 1,
			ownerGithubNodeId: "U_owner",
			login: "new-login",
		});

		expect(first).toMatchObject({ disposition: "inserted" });
		expect(second).toMatchObject({
			disposition: "updated",
			jobId: first?.jobId,
		});
	});
});
