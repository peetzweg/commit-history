import type { FollowedProfile } from "#/lib/github-following";
import { userNetworkMembers } from "#/lib/profile-network-members";
import type { ProfileNetworkJob } from "#/lib/profile-network-queue";

export interface ProfileNetworkDiscoveryStore {
	replaceSnapshot(
		ownerGithubNodeId: string,
		members: FollowedProfile[],
		at: Date,
	): Promise<void>;
	markComplete(ownerGithubNodeId: string): Promise<void>;
	markFailed(ownerGithubNodeId: string, error: string): Promise<void>;
}

interface ProfileNetworkDiscoveryDependencies {
	store: ProfileNetworkDiscoveryStore;
	admit?(
		ownerGithubNodeId: string,
		following: number,
	): Promise<"allowed" | "busy">;
	resolveOwner(
		githubNodeId: string,
		token: string,
	): Promise<{ login: string; following: number }>;
	fetchFollowing(
		login: string,
		token: string,
		signal?: AbortSignal,
	): Promise<FollowedProfile[]>;
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
			const owner = await deps.resolveOwner(job.ownerGithubNodeId, opts.token);
			const admission = await deps.admit?.(
				job.ownerGithubNodeId,
				owner.following,
			);
			if (admission === "busy") {
				throw new Error(
					"Network discovery is paused while the ingestion queue is busy.",
				);
			}
			const members = await deps.fetchFollowing(
				owner.login,
				opts.token,
				opts.signal,
			);
			opts.signal?.throwIfAborted();
			await deps.store.replaceSnapshot(
				job.ownerGithubNodeId,
				members,
				opts.now ?? new Date(),
			);
			await deps.store.markComplete(job.ownerGithubNodeId);
			return {
				membersFound: userNetworkMembers(members).length,
				profilesEnqueued: 0,
			};
		} catch (error) {
			await deps.store
				.markFailed(job.ownerGithubNodeId, String(error))
				.catch(() => {});
			throw error;
		}
	};
}
