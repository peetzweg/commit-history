import {
	createProfileIngestionBoss,
	createProfileIngestionQueue,
} from "#/lib/profile-ingestion-queue";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const boss = createProfileIngestionBoss(connectionString, { migrate: true });
const queue = createProfileIngestionQueue(boss);

try {
	await queue.start({ provision: true });
	console.log("profile-ingestion-queue status=ready");
} finally {
	await queue.stop().catch(() => {});
}
