import {
	createMonthlyRefreshBoss,
	createMonthlyRefreshQueue,
} from "#/lib/monthly-refresh-queue";
import {
	createOrgRefreshBoss,
	createOrgRefreshQueue,
} from "#/lib/org-refresh-queue";
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
const orgBoss = createOrgRefreshBoss(connectionString, { migrate: true });
const orgQueue = createOrgRefreshQueue(orgBoss);
const monthlyBoss = createMonthlyRefreshBoss(connectionString, {
	migrate: true,
});
const monthlyQueue = createMonthlyRefreshQueue(monthlyBoss);

try {
	await queue.start({ provision: true });
	console.log("profile-ingestion-queue status=ready");
	await networkQueue.start({ provision: true });
	console.log("profile-network-queue status=ready");
	await orgQueue.start({ provision: true });
	console.log("org-refresh-queue status=ready");
	await monthlyQueue.start({ provision: true });
	console.log("monthly-refresh-queue status=ready");
} finally {
	await queue.stop().catch(() => {});
	await networkQueue.stop().catch(() => {});
	await orgQueue.stop().catch(() => {});
	await monthlyQueue.stop().catch(() => {});
}
