import { isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import { profileNetworks } from "#/lib/db/schema";
import {
	MAX_FOLLOWED_PROFILES,
	MAX_PENDING_PROFILE_JOBS,
	networkAdmission,
} from "#/lib/profile-network-limits";
import { REQUEST_RETRY_MS } from "#/lib/profile-network-refresh";

/** Claim a network's worst-case queue room before GitHub enumeration begins. */
export async function claimNetworkDiscovery(
	database: DB,
	ownerId: string,
	following: number | null,
	now: Date,
	allowRecent = false,
): Promise<{
	admission: ReturnType<typeof networkAdmission>;
	claimed: typeof profileNetworks.$inferSelect | undefined;
}> {
	const retryBefore = new Date(now.getTime() - REQUEST_RETRY_MS);
	return database.transaction(async (tx) => {
		// All web and worker claims take the same transaction lock. Existing claims reserve
		// up to 250 slots until their requests are sent or the recovery window expires.
		await tx.execute(sql`SELECT pg_advisory_xact_lock(787888369009)`);
		const [budget] = await tx.execute<{
			pending: number;
			reserved: number;
		}>(sql`
			SELECT
				(SELECT count(*)::int FROM (
					SELECT 1 FROM pgboss.job
					WHERE name = 'profile-ingestion-v1'
						AND state IN ('created', 'active', 'retry')
					LIMIT ${MAX_PENDING_PROFILE_JOBS}
				) AS jobs) AS pending,
				(SELECT count(*)::int FROM profile_networks
					WHERE refresh_requested_at >= ${retryBefore}
						AND owner_id <> ${ownerId}) AS reserved
		`);
		const admission = networkAdmission(
			following,
			(budget?.pending ?? 0) + (budget?.reserved ?? 0) * MAX_FOLLOWED_PROFILES,
		);
		if (admission !== "allowed") return { admission, claimed: undefined };

		const [claimed] = await tx
			.insert(profileNetworks)
			.values({ ownerId, refreshRequestedAt: now })
			.onConflictDoUpdate({
				target: profileNetworks.ownerId,
				set: { refreshRequestedAt: now },
				...(allowRecent
					? {}
					: {
							setWhere: or(
								isNull(profileNetworks.refreshRequestedAt),
								lt(profileNetworks.refreshRequestedAt, retryBefore),
							),
						}),
			})
			.returning();
		return { admission, claimed };
	});
}
