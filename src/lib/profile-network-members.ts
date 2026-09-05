/**
 * Network snapshots preserve both people and organizations returned by GitHub. The personal
 * leaderboard is deliberately people-only, so every consumer crosses this explicit boundary.
 */
export function userNetworkMembers<T extends { kind: string }>(
	members: readonly T[],
): T[] {
	return members.filter((member) => member.kind === "user");
}
