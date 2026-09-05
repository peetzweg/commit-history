import type { FollowedProfile } from "#/lib/github-following";
import type { ProfileIngestionJob } from "#/lib/profile-ingestion-queue";
import { userNetworkMembers } from "#/lib/profile-network-members";
import type { ProfileNetworkJob } from "#/lib/profile-network-queue";

export interface ProfileNetworkDiscoveryStore {
	replaceSnapshot(
		ownerGithubNodeId: string,
		members: FollowedProfile[],
		at: Date,
	): Promise<FollowedProfile[]>;
	markComplete(ownerGithubNodeId: string): Promise<void>;
	markFailed(ownerGithubNodeId: string, error: string): Promise<void>;
}

interface ProfileNetworkDiscoveryDependencies {
	store: ProfileNetworkDiscoveryStore;
	fetchFollowing(
		login: string,
		token: string,
		signal?: AbortSignal,
	): Promise<FollowedProfile[]>;
	requestIngestion(job: ProfileIngestionJob): Promise<unknown>;
}

export interface ProfileNetworkDiscoveryResult {
	membersFound: number;
	profilesEnqueued: number;
}

/**
 * Complete-snapshot discovery behind one interface. Callers do not need to understand GitHub
 * pagination, identity reconciliation, or how missing histories enter the ingestion queue.
 */
export function createProfileNetworkDiscovery(
	deps: ProfileNetworkDiscoveryDependencies,
) {
	return async function discoverProfileNetwork(
		job: ProfileNetworkJob,
		opts: { token: string; signal?: AbortSignal; now?: Date },
	): Promise<ProfileNetworkDiscoveryResult> {
		try {
			const members = await deps.fetchFollowing(
				job.login,
				opts.token,
				opts.signal,
			);
			opts.signal?.throwIfAborted();
			const missing = await deps.store.replaceSnapshot(
				job.ownerGithubNodeId,
				members,
				opts.now ?? new Date(),
			);
			const missingUsers = userNetworkMembers(missing);

			// Bound the fan-out while still letting pg-boss coalesce identities shared by networks.
			for (let index = 0; index < missingUsers.length; index += 10) {
				opts.signal?.throwIfAborted();
				await Promise.all(
					missingUsers.slice(index, index + 10).map((member) =>
						deps.requestIngestion({
							version: 1,
							githubNodeId: member.githubNodeId,
							login: member.login,
						}),
					),
				);
			}
			await deps.store.markComplete(job.ownerGithubNodeId);
			return {
				membersFound: userNetworkMembers(members).length,
				profilesEnqueued: missingUsers.length,
			};
		} catch (error) {
			await deps.store
				.markFailed(job.ownerGithubNodeId, String(error))
				.catch(() => {});
			throw error;
		}
	};
}
