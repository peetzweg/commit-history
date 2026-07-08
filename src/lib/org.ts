import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
	LEADERBOARD_MAX,
	lookupUsers,
	serverToken,
	type UserResult,
} from "#/lib/commit-history";
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

/** Plain server-side resolution — shared by getOrg and getLookup (server functions must not
 *  call each other: a server-side call turns into an HTTP self-fetch). */
async function resolveOrg(login: string): Promise<OrgResult> {
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
}

export const getOrg = createServerFn({ method: "GET" })
	// Same coercion rationale as getCommitHistory: never trust the wire type.
	.validator((login: string) => (typeof login === "string" ? login : ""))
	.handler(({ data: login }): Promise<OrgResult> => resolveOrg(login));

export type LookupResult =
	| { kind: "users"; users: UserResult[] }
	| { kind: "org"; org: OrgResult };

/** Which kinds this login's entity rows already have in the DB (no GitHub calls). */
async function knownKinds(login: string): Promise<Set<string>> {
	if (!db) return new Set();
	const key = login.trim().toLowerCase();
	try {
		const rows = await db
			.select({ kind: entities.kind })
			.from(entities)
			.where(inArray(entities.id, [`user:${key}`, `org:${key}`]));
		return new Set(rows.map((r) => r.kind));
	} catch {
		return new Set(); // best-effort — fall through to the user-first path
	}
}

/**
 * Resolve what a /$user path segment actually is. GitHub logins share ONE namespace across
 * users and organizations, so /paritytech can be the org page — no /org/ prefix needed.
 *
 * Resolution order: a login already stored as an org (and not as a user) goes straight to the
 * org path — without this, every poll of a building org would burn a doomed user lookup on
 * GitHub first. Unknown logins try the user path (the overwhelmingly common case) and fall back
 * to the org path only on GitHub's "not a User" rejection, so a brand-new org costs exactly one
 * extra request on its very first sighting. Multi-login comparisons stay users-only.
 */
export const getLookup = createServerFn({ method: "GET" })
	// The loader sends parseLogins output, but the RPC endpoint is public — coerce defensively;
	// getCommitHistories re-normalizes (dedupes/caps) the list itself.
	.validator((logins: string[]) =>
		Array.isArray(logins) ? logins.filter((l) => typeof l === "string") : [],
	)
	.handler(async ({ data: logins }): Promise<LookupResult> => {
		const solo = logins.length === 1 ? logins[0] : null;
		if (solo) {
			const kinds = await knownKinds(solo);
			// Both kinds existing at once means a login changed hands across a rename — prefer the
			// user row (the historical default) and let the org stay reachable via /companies.
			if (kinds.has("org") && !kinds.has("user")) {
				return { kind: "org", org: await resolveOrg(solo) };
			}
		}
		const users = await lookupUsers(logins);
		if (
			solo &&
			users[0]?.error &&
			/could not resolve to a user/i.test(users[0].error)
		) {
			const org = await resolveOrg(solo);
			if (org.org || org.building) return { kind: "org", org };
			// The login isn't a user. If the org path failed for any reason other than "no such
			// org" (token scopes, a GitHub hiccup mid-build), that error is the truthful one —
			// surface it instead of the misleading user 404. A login that is neither keeps the
			// user message, the right default for someone who typed a username.
			if (org.error && !/not found/i.test(org.error)) {
				return { kind: "org", org };
			}
		}
		return { kind: "users", users };
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
