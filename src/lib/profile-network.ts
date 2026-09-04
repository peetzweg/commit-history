import { createServerFn } from "@tanstack/react-start";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { ChartMode } from "#/components/CommitChart";
import { db } from "#/lib/db";
import {
	entities,
	profileNetworkMembers,
	profileNetworks,
} from "#/lib/db/schema";
import { leaderboardValue } from "#/lib/leaderboard-display";

const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_RETRY_MS = 5 * 60 * 1_000;

export interface NetworkLeaderEntry {
	githubNodeId: string;
	login: string;
	name: string | null;
	avatarUrl: string | null;
	totalCommits: number;
	totalRestricted: number;
	totalIssues: number | null;
	totalPullRequests: number | null;
	totalReviews: number | null;
	totalRepos: number | null;
	followers: number | null;
	isOwner: boolean;
}

export interface PendingNetworkEntry {
	githubNodeId: string;
	login: string;
	avatarUrl: string | null;
}

export interface ProfileNetworkReadModel {
	status: "unavailable" | "discovering" | "refreshing" | "ready";
	ownerLogin: string;
	totalCount: number;
	readyCount: number;
	unavailableCount: number;
	rows: NetworkLeaderEntry[];
	pendingRows: PendingNetworkEntry[];
	hasError: boolean;
}

interface ProfileNetworkRequest {
	ownerGithubNodeId: string;
	metric: ChartMode;
}

const entryColumns = {
	id: entities.id,
	githubNodeId: entities.githubNodeId,
	login: entities.login,
	name: entities.name,
	avatarUrl: entities.avatarUrl,
	totalCommits: entities.totalCommits,
	totalRestricted: entities.totalRestricted,
	totalIssues: entities.totalIssues,
	totalPullRequests: entities.totalPullRequests,
	totalReviews: entities.totalReviews,
	totalRepos: entities.totalRepos,
	followers: entities.followers,
	following: entities.following,
	builtAt: entities.builtAt,
	suspendedAt: entities.suspendedAt,
};

/** Read model for the profile page; a missing/stale identity snapshot is refreshed inline. */
export const getProfileNetwork = createServerFn({ method: "POST" })
	.validator((value: ProfileNetworkRequest) => {
		const metrics: ChartMode[] = [
			"public",
			"prs",
			"issues",
			"reviews",
			"repos",
			"private",
			"total",
		];
		return {
			ownerGithubNodeId:
				typeof value?.ownerGithubNodeId === "string" &&
				Boolean(value.ownerGithubNodeId.trim()) &&
				value.ownerGithubNodeId.trim().length <= 255
					? value.ownerGithubNodeId.trim()
					: "",
			metric: metrics.includes(value?.metric) ? value.metric : "public",
		};
	})
	.handler(async ({ data }): Promise<ProfileNetworkReadModel> => {
		if (!db || !data.ownerGithubNodeId) return unavailable("");
		const database = db;
		const [owner] = await database
			.select(entryColumns)
			.from(entities)
			.where(
				and(
					eq(entities.kind, "user"),
					eq(entities.githubNodeId, data.ownerGithubNodeId),
					isNotNull(entities.builtAt),
				),
			)
			.limit(1);
		if (!owner?.githubNodeId) return unavailable("");

		let [network] = await database
			.select()
			.from(profileNetworks)
			.where(eq(profileNetworks.ownerId, owner.id))
			.limit(1);
		const now = new Date();
		const staleBefore = new Date(now.getTime() - SNAPSHOT_TTL_MS);
		const retryBefore = new Date(now.getTime() - REQUEST_RETRY_MS);
		const needsRefresh =
			!network?.enumeratedAt || network.enumeratedAt < staleBefore;
		const needsWork = needsRefresh || network?.lastError != null;
		const mayRequest =
			!network?.refreshRequestedAt || network.refreshRequestedAt < retryBefore;

		if (needsWork && mayRequest) {
			const [claimed] = await database
				.insert(profileNetworks)
				.values({ ownerId: owner.id, refreshRequestedAt: now })
				.onConflictDoUpdate({
					target: profileNetworks.ownerId,
					set: { refreshRequestedAt: now },
					setWhere: or(
						isNull(profileNetworks.refreshRequestedAt),
						lt(profileNetworks.refreshRequestedAt, retryBefore),
					),
				})
				.returning();
			if (claimed) {
				network = claimed;
				const job = {
					version: 1,
					ownerGithubNodeId: owner.githubNodeId,
					login: owner.login,
				} as const;
				try {
					const { discoverProfileNetworkLive } = await import(
						"#/lib/profile-network-live"
					);
					await discoverProfileNetworkLive(job);
				} catch (error) {
					// Preserve the request's responsiveness and durability when GitHub or the direct
					// producer is temporarily unavailable. The worker retries the complete operation.
					const { requestProfileNetwork } = await import(
						"#/lib/profile-network-producer"
					);
					await requestProfileNetwork(job).catch(async (queueError) => {
						await database
							.update(profileNetworks)
							.set({
								lastError:
									`${String(error)}; fallback: ${String(queueError)}`.slice(
										0,
										2_000,
									),
							})
							.where(eq(profileNetworks.ownerId, owner.id));
					});
				}
				[network] = await database
					.select()
					.from(profileNetworks)
					.where(eq(profileNetworks.ownerId, owner.id))
					.limit(1);
			}
		}

		const members = await database
			.select({
				memberGithubNodeId: profileNetworkMembers.memberGithubNodeId,
				login: profileNetworkMembers.login,
				avatarUrl: profileNetworkMembers.avatarUrl,
				unavailableAt: profileNetworkMembers.unavailableAt,
				profile: entryColumns,
			})
			.from(profileNetworkMembers)
			.leftJoin(
				entities,
				and(
					eq(entities.kind, "user"),
					eq(entities.githubNodeId, profileNetworkMembers.memberGithubNodeId),
				),
			)
			.where(eq(profileNetworkMembers.ownerId, owner.id));

		const readyCount = members.filter(
			(member) =>
				member.profile?.builtAt != null && !member.profile.suspendedAt,
		).length;
		const unavailableCount = members.filter(
			(member) =>
				!(member.profile?.builtAt && !member.profile.suspendedAt) &&
				(member.unavailableAt != null ||
					(member.profile?.builtAt != null &&
						member.profile.suspendedAt != null)),
		).length;
		const rows: NetworkLeaderEntry[] = [
			toEntry({ ...owner, githubNodeId: owner.githubNodeId }, true),
		];
		for (const member of members) {
			const profile = member.profile;
			if (!profile?.githubNodeId || !profile.builtAt || profile.suspendedAt) {
				continue;
			}
			rows.push(
				toEntry({ ...profile, githubNodeId: profile.githubNodeId }, false),
			);
		}
		rows.sort((left, right) => {
			const difference =
				leaderboardValue(right, data.metric) -
				leaderboardValue(left, data.metric);
			return difference || left.githubNodeId.localeCompare(right.githubNodeId);
		});
		const pendingRows = members
			.filter(
				(member) =>
					member.unavailableAt == null && member.profile?.builtAt == null,
			)
			.map((member) => ({
				githubNodeId: member.memberGithubNodeId,
				login: member.login,
				avatarUrl: member.avatarUrl,
			}))
			.sort((left, right) => left.login.localeCompare(right.login));

		const snapshotStale =
			!network?.enumeratedAt || network.enumeratedAt < staleBefore;
		const totalCount = network?.enumeratedAt
			? members.length
			: (owner.following ?? 0);
		return {
			status: !network?.enumeratedAt
				? "discovering"
				: snapshotStale
					? "refreshing"
					: "ready",
			ownerLogin: owner.login,
			totalCount,
			readyCount,
			unavailableCount,
			rows,
			pendingRows,
			hasError: network?.lastError != null,
		};
	});

interface EntryRow {
	githubNodeId: string;
	login: string;
	name: string | null;
	avatarUrl: string | null;
	totalCommits: number;
	totalRestricted: number;
	totalIssues: number | null;
	totalPullRequests: number | null;
	totalReviews: number | null;
	totalRepos: number | null;
	followers: number | null;
}

function toEntry(row: EntryRow, isOwner: boolean): NetworkLeaderEntry {
	return {
		githubNodeId: row.githubNodeId,
		login: row.login,
		name: row.name,
		avatarUrl: row.avatarUrl,
		totalCommits: row.totalCommits,
		totalRestricted: row.totalRestricted,
		totalIssues: row.totalIssues,
		totalPullRequests: row.totalPullRequests,
		totalReviews: row.totalReviews,
		totalRepos: row.totalRepos,
		followers: row.followers,
		isOwner,
	};
}

function unavailable(login: string): ProfileNetworkReadModel {
	return {
		status: "unavailable",
		ownerLogin: login,
		totalCount: 0,
		readyCount: 0,
		unavailableCount: 0,
		rows: [],
		pendingRows: [],
		hasError: false,
	};
}
