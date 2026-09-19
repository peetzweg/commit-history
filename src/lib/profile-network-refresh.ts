import { isNetworkTooLargeFailure } from "#/lib/profile-network-discovery";

const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;
export const REQUEST_RETRY_MS = 5 * 60 * 1_000;

interface NetworkRefreshState {
	enumeratedAt: Date | null;
	refreshRequestedAt: Date | null;
	lastError: string | null;
}

/** A saved snapshot is unfinished until its ingestion requests have been submitted. */
export function shouldRequestProfileNetwork(
	network: NetworkRefreshState | undefined,
	now: Date,
): boolean {
	if (isNetworkTooLargeFailure(network?.lastError)) return false;
	const retryBefore = new Date(now.getTime() - REQUEST_RETRY_MS);
	if (
		network?.refreshRequestedAt &&
		network.refreshRequestedAt >= retryBefore
	) {
		return false;
	}
	return (
		!network?.enumeratedAt ||
		network.enumeratedAt < new Date(now.getTime() - SNAPSHOT_TTL_MS) ||
		network.lastError != null ||
		network.refreshRequestedAt != null
	);
}

/** Passive profile views may read an existing board; only an explicit start may create one. */
export function shouldStartProfileNetworkDiscovery(
	network: NetworkRefreshState | undefined,
	now: Date,
	explicitlyRequested: boolean,
): boolean {
	return (
		(explicitlyRequested || network?.refreshRequestedAt != null) &&
		shouldRequestProfileNetwork(network, now)
	);
}
