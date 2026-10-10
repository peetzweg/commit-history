import {
	createOrgRefreshBoss,
	createOrgRefreshQueue,
	type OrgRefreshQueue,
} from "#/lib/org-refresh-queue";

let producer: Promise<OrgRefreshQueue> | undefined;

/**
 * Ask the worker to bring an org up to the last completed month. Called from the org page's
 * request path, so it only records intent; the GitHub work happens in the worker.
 */
export async function requestOrgRefresh(login: string) {
	const queue = await orgRefreshProducer();
	await queue.request({ version: 1, login });
}

async function orgRefreshProducer(): Promise<OrgRefreshQueue> {
	if (producer) return producer;
	producer = startProducer().catch((error) => {
		producer = undefined;
		throw error;
	});
	return producer;
}

async function startProducer(): Promise<OrgRefreshQueue> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error("DATABASE_URL is required.");
	const boss = createOrgRefreshBoss(connectionString);
	boss.on("error", (error) => {
		console.error(
			`org-refresh-producer status=queue_error error=${JSON.stringify(String(error))}`,
		);
	});
	const queue = createOrgRefreshQueue(boss);
	try {
		await queue.start();
	} catch (error) {
		await queue.stop().catch(() => {});
		throw error;
	}
	return queue;
}
