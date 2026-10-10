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

/**
 * Thrown when discovery must wait without having spent anything on GitHub. The worker reschedules
 * the job for `retryAt` instead of counting it as a failure.
 */
export class NetworkDiscoveryDeferred extends Error {
	constructor(
		readonly reason: "profile_queue_busy" | "rate_limit_floor",
		readonly retryAt: Date,
	) {
		super(`Network discovery deferred: ${reason}.`);
	}
}

/** How long to wait before re-checking a full ingestion queue. */
const BUSY_RETRY_MS = 5 * 60_000;

interface ProfileNetworkDiscoveryDependencies {
	store: ProfileNetworkDiscoveryStore;
	admit?(ownerGithubNodeId: string): Promise<"allowed" | "busy">;
	/**
	 * When the shared token is below its reserved floor, the time to retry at; null to proceed.
	 * Checked before the first GitHub request so a waiting job costs nothing.
	 */
	budgetDeferral?(token: string): Promise<Date | null>;
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
		// Both gates run before any GitHub request. A full ingestion queue used to be detected only
		// after resolving the owner, so thousands of waiting jobs each spent a GraphQL request every
		// five minutes just to learn "not yet" — enough to pin the shared token at zero.
		if ((await deps.admit?.(job.ownerGithubNodeId)) === "busy") {
			throw new NetworkDiscoveryDeferred(
				"profile_queue_busy",
				new Date(Date.now() + BUSY_RETRY_MS),
			);
		}
		const retryAt = await deps.budgetDeferral?.(opts.token);
		if (retryAt)
			throw new NetworkDiscoveryDeferred("rate_limit_floor", retryAt);

		try {
			const owner = await deps.resolveOwner(job.ownerGithubNodeId, opts.token);
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
