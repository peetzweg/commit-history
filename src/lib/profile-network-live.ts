import { db } from "#/lib/db";
import { fetchFollowing } from "#/lib/github-following";
import { requestProfileIngestion } from "#/lib/profile-ingestion-producer";
import { createProfileNetworkDiscovery } from "#/lib/profile-network-discovery";
import type { ProfileNetworkJob } from "#/lib/profile-network-queue";
import { createProfileNetworkDiscoveryStore } from "#/lib/profile-network-store";

/**
 * Fast path for a profile page: enumerate the lightweight public identity list now, persist it,
 * and submit only the expensive history builds to pg-boss.
 */
export async function discoverProfileNetworkLive(job: ProfileNetworkJob) {
	const token = process.env.GITHUB_TOKEN?.trim();
	if (!db) throw new Error("Database is unavailable.");
	if (!token) throw new Error("GITHUB_TOKEN is required.");

	return createProfileNetworkDiscovery({
		store: createProfileNetworkDiscoveryStore(db),
		fetchFollowing,
		requestIngestion: requestProfileIngestion,
	})(job, { token });
}
