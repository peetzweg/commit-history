import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import {
	entities,
	profileNetworkMembers,
	profileNetworks,
} from "#/lib/db/schema";
import type { ProfileIngestionQueue } from "#/lib/profile-ingestion-queue";
import {
	MAX_PENDING_PROFILE_JOBS,
	NETWORK_BACKFILL_BATCH,
} from "#/lib/profile-network-limits";

const PROFILE_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Submit one bounded slice of a saved network. Cursor and pg-boss jobs commit together. */
export async function backfillProfileNetwork(
	database: DB,
	queue: ProfileIngestionQueue,
	now = new Date(),
): Promise<{ examined: number; enqueued: number; completed: boolean }> {
	return database.transaction(async (tx) => {
		// Discovery claims use the same lock, so the 1,000-job ceiling includes this batch.
		await tx.execute(sql`SELECT pg_advisory_xact_lock(787888369009)`);
		const [budget] = await tx.execute<{ pending: number }>(sql`
			SELECT count(*)::int AS pending FROM (
				SELECT 1 FROM pgboss.job
				WHERE name = 'profile-ingestion-v1'
					AND state IN ('created', 'active', 'retry')
				LIMIT ${MAX_PENDING_PROFILE_JOBS}
			) AS jobs
		`);
		const room = Math.min(
			NETWORK_BACKFILL_BATCH,
			MAX_PENDING_PROFILE_JOBS - (budget?.pending ?? 0),
		);
		if (room <= 0) return { examined: 0, enqueued: 0, completed: false };

		const [network] = await tx
			.select()
			.from(profileNetworks)
			.where(isNotNull(profileNetworks.backfillCursor))
			.orderBy(sql`random()`)
			.limit(1);
		if (!network || network.backfillCursor === null) {
			return { examined: 0, enqueued: 0, completed: false };
		}
		const members = await tx
			.select({
				nodeId: profileNetworkMembers.memberGithubNodeId,
				login: profileNetworkMembers.login,
				unavailableAt: profileNetworkMembers.unavailableAt,
				builtAt: entities.builtAt,
				lastFetched: entities.lastFetched,
			})
			.from(profileNetworkMembers)
			.leftJoin(
				entities,
				and(
					eq(entities.kind, "user"),
					eq(entities.githubNodeId, profileNetworkMembers.memberGithubNodeId),
				),
			)
			.where(
				and(
					eq(profileNetworkMembers.ownerId, network.ownerId),
					eq(profileNetworkMembers.kind, "user"),
					gt(profileNetworkMembers.memberGithubNodeId, network.backfillCursor),
				),
			)
			.orderBy(profileNetworkMembers.memberGithubNodeId)
			.limit(room);

		const freshAfter = new Date(now.getTime() - PROFILE_REFRESH_TTL_MS);
		let enqueued = 0;
		for (const member of members) {
			if (
				member.unavailableAt ||
				(member.builtAt &&
					member.lastFetched &&
					member.lastFetched >= freshAfter)
			)
				continue;
			await queue.request(
				{ version: 1, githubNodeId: member.nodeId, login: member.login },
				{ transaction: tx },
			);
			enqueued += 1;
		}
		const cursor = members.at(-1)?.nodeId ?? null;
		await tx
			.update(profileNetworks)
			.set({ backfillCursor: cursor })
			.where(eq(profileNetworks.ownerId, network.ownerId));
		return {
			examined: members.length,
			enqueued,
			completed: cursor === null,
		};
	});
}
