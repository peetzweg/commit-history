import { and, eq, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import {
	entities,
	profileNetworkMembers,
	profileNetworks,
} from "#/lib/db/schema";
import type { ProfileNetworkDiscoveryStore } from "#/lib/profile-network-discovery";

export function createProfileNetworkDiscoveryStore(
	database: DB,
): ProfileNetworkDiscoveryStore {
	async function ownerId(githubNodeId: string): Promise<string> {
		const [owner] = await database
			.select({ id: entities.id })
			.from(entities)
			.where(
				and(eq(entities.kind, "user"), eq(entities.githubNodeId, githubNodeId)),
			)
			.limit(1);
		if (!owner)
			throw new Error(`Network owner ${githubNodeId} is not tracked.`);
		return owner.id;
	}

	return {
		async replaceSnapshot(ownerGithubNodeId, members, at) {
			const id = await ownerId(ownerGithubNodeId);
			await database.transaction(async (tx) => {
				// Keep cursor resets and member replacement atomic with a worker backfill pass.
				await tx.execute(sql`SELECT pg_advisory_xact_lock(787888369009)`);
				await tx
					.insert(profileNetworks)
					.values({ ownerId: id, enumeratedAt: at, backfillCursor: "" })
					.onConflictDoUpdate({
						target: profileNetworks.ownerId,
						set: { enumeratedAt: at, backfillCursor: "" },
					});
				await tx
					.delete(profileNetworkMembers)
					.where(eq(profileNetworkMembers.ownerId, id));
				for (let index = 0; index < members.length; index += 500) {
					await tx.insert(profileNetworkMembers).values(
						members.slice(index, index + 500).map((member) => ({
							ownerId: id,
							memberGithubNodeId: member.githubNodeId,
							login: member.login,
							kind: member.kind,
							avatarUrl: member.avatarUrl,
							htmlUrl: member.htmlUrl,
						})),
					);
				}
			});
		},

		async markComplete(ownerGithubNodeId) {
			const id = await ownerId(ownerGithubNodeId);
			await database
				.update(profileNetworks)
				.set({ refreshRequestedAt: null, lastError: null })
				.where(eq(profileNetworks.ownerId, id));
		},

		async markFailed(ownerGithubNodeId, error) {
			const id = await ownerId(ownerGithubNodeId);
			await database
				.insert(profileNetworks)
				.values({ ownerId: id, lastError: error.slice(0, 2_000) })
				.onConflictDoUpdate({
					target: profileNetworks.ownerId,
					set: { lastError: error.slice(0, 2_000) },
				});
		},
	};
}
