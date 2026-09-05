import {
	createProfileNetworkBoss,
	createProfileNetworkQueue,
	type ProfileNetworkJob,
	type ProfileNetworkQueue,
} from "#/lib/profile-network-queue";

let producer: Promise<ProfileNetworkQueue> | undefined;

/** One lazily-started producer per web process; repeated page reads only upsert one owner job. */
export async function requestProfileNetwork(job: ProfileNetworkJob) {
	const queue = await networkProducer();
	return queue.request(job);
}

async function networkProducer(): Promise<ProfileNetworkQueue> {
	if (producer) return producer;
	producer = startProducer().catch((error) => {
		producer = undefined;
		throw error;
	});
	return producer;
}

async function startProducer(): Promise<ProfileNetworkQueue> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error("DATABASE_URL is required.");
	const boss = createProfileNetworkBoss(connectionString);
	boss.on("error", (error) => {
		console.error(
			`profile-network-producer status=queue_error error=${JSON.stringify(String(error))}`,
		);
	});
	const queue = createProfileNetworkQueue(boss);
	await queue.start();
	return queue;
}
