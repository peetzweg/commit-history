import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { DB } from "#/lib/db";
import {
	entities,
	profileNetworkMembers,
	profileNetworks,
} from "#/lib/db/schema";
import type { ProfileNetworkDiscoveryStore } from "#/lib/profile-network-discovery";

const ID_QUERY_CHUNK = 500;
const PROFILE_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

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
				await tx
					.insert(profileNetworks)
					.values({ ownerId: id, enumeratedAt: at })
					.onConflictDoUpdate({
						target: profileNetworks.ownerId,
						set: { enumeratedAt: at },
					});
				await tx
					.delete(profileNetworkMembers)
					.where(eq(profileNetworkMembers.ownerId, id));
				if (members.length > 0) {
					await tx.insert(profileNetworkMembers).values(
						members.map((member) => ({
							ownerId: id,
							memberGithubNodeId: member.githubNodeId,
							login: member.login,
							avatarUrl: member.avatarUrl,
							htmlUrl: member.htmlUrl,
						})),
					);
				}
			});

			const fresh = new Set<string>();
			const freshAfter = new Date(at.getTime() - PROFILE_REFRESH_TTL_MS);
			for (let index = 0; index < members.length; index += ID_QUERY_CHUNK) {
				const ids = members
					.slice(index, index + ID_QUERY_CHUNK)
					.map((member) => member.githubNodeId);
				const rows = await database
					.select({
						githubNodeId: entities.githubNodeId,
						lastFetched: entities.lastFetched,
					})
					.from(entities)
					.where(
						and(
							eq(entities.kind, "user"),
							isNotNull(entities.builtAt),
							inArray(entities.githubNodeId, ids),
						),
					);
				for (const row of rows) {
					if (
						row.githubNodeId &&
						row.lastFetched &&
						row.lastFetched >= freshAfter
					) {
						fresh.add(row.githubNodeId);
					}
				}
			}
			return members.filter((member) => !fresh.has(member.githubNodeId));
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
