import {
	type CurrentMonthQueue,
	createCurrentMonthBoss,
	createCurrentMonthQueue,
} from "#/lib/current-month-queue";

let producer: Promise<CurrentMonthQueue> | undefined;

/**
 * Ask the worker to re-read a user's month-to-date counts. Called from the lookup path, so it only
 * records intent; the GitHub request happens in the worker.
 */
export async function requestCurrentMonthRefresh(login: string) {
	const queue = await currentMonthProducer();
	await queue.requestLookup({ version: 1, login });
}

async function currentMonthProducer(): Promise<CurrentMonthQueue> {
	if (producer) return producer;
	producer = startProducer().catch((error) => {
		producer = undefined;
		throw error;
	});
	return producer;
}

async function startProducer(): Promise<CurrentMonthQueue> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error("DATABASE_URL is required.");
	const boss = createCurrentMonthBoss(connectionString);
	boss.on("error", (error) => {
		console.error(
			`current-month-producer status=queue_error error=${JSON.stringify(String(error))}`,
		);
	});
	const queue = createCurrentMonthQueue(boss);
	try {
		await queue.start();
	} catch (error) {
		await queue.stop().catch(() => {});
		throw error;
	}
	return queue;
}
