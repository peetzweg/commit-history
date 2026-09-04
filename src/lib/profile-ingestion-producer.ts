import {
	createProfileIngestionBoss,
	createProfileIngestionQueue,
	type ProfileIngestionJob,
	type ProfileIngestionQueue,
} from "#/lib/profile-ingestion-queue";

let producer: Promise<ProfileIngestionQueue> | undefined;

/** Queue profile histories from a web request without making the request perform the ingestion. */
export async function requestProfileIngestion(job: ProfileIngestionJob) {
	const queue = await ingestionProducer();
	return queue.request(job);
}

async function ingestionProducer(): Promise<ProfileIngestionQueue> {
	if (producer) return producer;
	producer = startProducer().catch((error) => {
		producer = undefined;
		throw error;
	});
	return producer;
}

async function startProducer(): Promise<ProfileIngestionQueue> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error("DATABASE_URL is required.");
	const boss = createProfileIngestionBoss(connectionString);
	boss.on("error", (error) => {
		console.error(
			`profile-ingestion-producer status=queue_error error=${JSON.stringify(String(error))}`,
		);
	});
	const queue = createProfileIngestionQueue(boss);
	await queue.start();
	return queue;
}
