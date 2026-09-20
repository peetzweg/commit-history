import {
	createProfileIngestionBoss,
	createProfileIngestionQueue,
} from "#/lib/profile-ingestion-queue";
import {
	createProfileNetworkBoss,
	createProfileNetworkQueue,
} from "#/lib/profile-network-queue";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const boss = createProfileIngestionBoss(connectionString, { migrate: true });
const queue = createProfileIngestionQueue(boss);
const networkBoss = createProfileNetworkBoss(connectionString, { migrate: true });
const networkQueue = createProfileNetworkQueue(networkBoss);

try {
	await queue.start({ provision: true });
	console.log("profile-ingestion-queue status=ready");
	await networkQueue.start({ provision: true });
	console.log("profile-network-queue status=ready");
} finally {
	await queue.stop().catch(() => {});
	await networkQueue.stop().catch(() => {});
}
