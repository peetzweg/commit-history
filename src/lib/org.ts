import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { LEADERBOARD_MAX, serverToken } from "#/lib/commit-history";
import { db } from "#/lib/db";
import { entities } from "#/lib/db/schema";
import { type BuildProgress, GitHubError } from "#/lib/github";
import { getOrgSummary, type OrgSummary } from "#/lib/org-cache";

/**
 * Server functions for org ("company") pages and the company leaderboard. Split from
 * commit-history.ts to keep that module user-only; same createServerFn conventions (and the
 * same "don't rename to *.server.ts" caveat documented there).
 */

export interface OrgResult {
	login: string;
	org: OrgSummary | null;
	error: string | null;
	// Non-null while the initial server-side build is still in progress — each poll of the loader
	// advances it (progress counts *members*, not months). Mutually exclusive with `error`.
	building: BuildProgress | null;
}

export const getOrg = createServerFn({ method: "GET" })
	// Same coercion rationale as getCommitHistory: never trust the wire type.
	.validator((login: string) => (typeof login === "string" ? login : ""))
	.handler(async ({ data: login }): Promise<OrgResult> => {
		try {
			const org = await getOrgSummary(login, serverToken());
			return { login, org, error: null, building: null };
		} catch (e) {
			// The 503 "still building" rejection carries progress — surface it as `building` so the
			// client polls to continue instead of showing a failure card (same mapping as the user
			// results in getCommitHistories).
			const building =
				e instanceof GitHubError && e.status === 503 && e.progress
					? e.progress
					: null;
			return {
				login,
				org: null,
				error: building
					? null
					: e instanceof Error
						? e.message
						: "Failed to load",
				building,
			};
		}
	});

export interface CompanyLeaderEntry {
	login: string;
	name: string | null;
	avatarUrl: string | null;
	isVerified: boolean | null;
	memberCount: number | null;
	totalCommits: number;
	// Nullable like LeaderEntry's per-type totals (never null in practice for orgs — the roll-up
	// writes all four — but the columns themselves are nullable).
	totalPullRequests: number | null;
	totalReviews: number | null;
	totalIssues: number | null;
}

/**
 * Companies ranked by their members' org-scoped commits. Only fully built orgs appear — a
 * half-built org's totals are still zero/partial and would rank nonsense. v1 ranks by commits
 * only; the per-metric machinery can follow once orgs get their own metric bar.
 */
async function queryCompanyLeaderboard(
	offset: number,
	limit: number,
): Promise<CompanyLeaderEntry[]> {
	if (!db) return [];
	return (
		db
			.select({
				login: entities.login,
				name: entities.name,
				avatarUrl: entities.avatarUrl,
				isVerified: entities.isVerified,
				memberCount: entities.memberCount,
				totalCommits: entities.totalCommits,
				totalPullRequests: entities.totalPullRequests,
				totalReviews: entities.totalReviews,
				totalIssues: entities.totalIssues,
			})
			.from(entities)
			.where(
				and(
					eq(entities.kind, "org"),
					isNull(entities.suspendedAt),
					isNotNull(entities.builtAt),
				),
			)
			// Same deterministic tiebreak rationale as queryLeaderboard.
			.orderBy(desc(entities.totalCommits), asc(entities.id))
			.limit(limit)
			.offset(offset)
	);
}

/** One page of the company leaderboard — same clamp conventions as getLeaderboard. */
export const getCompanyLeaderboard = createServerFn({ method: "GET" })
	.validator((p: { offset: number; limit: number }) => p)
	.handler(({ data }): Promise<CompanyLeaderEntry[]> => {
		const offset = Math.min(Math.max(0, data.offset), LEADERBOARD_MAX);
		const limit = Math.min(Math.max(0, data.limit), LEADERBOARD_MAX - offset);
		return queryCompanyLeaderboard(offset, limit);
	});
