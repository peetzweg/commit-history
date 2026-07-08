import { and, eq, isNull, sql } from "drizzle-orm";
import { recordLookup } from "#/lib/cache";
import { type DB, db } from "#/lib/db";
import { entities, orgMembers } from "#/lib/db/schema";
import {
	fetchOrgMemberContributions,
	fetchOrgMembers,
	fetchOrgProfile,
	GitHubError,
	type OrgMember,
	type OrgProfile,
	yearlyWindows,
} from "#/lib/github";

/**
 * Incremental organization cache — the org sibling of cache.ts.
 *
 * An org's numbers are the sum of its members' contributions *to that org* (org-scoped
 * `contributionsCollection(organizationID: …)`, a different number from each member's global
 * totals). Those per-member sums live in `org_members`; the roll-up lands on the org's
 * `entities` row so the organization leaderboard ranks orgs exactly like the user board ranks
 * users.
 *
 * Builds are **resumable** at member granularity: enumeration inserts every member as a pending
 * `org_members` row (`lastFetched` null), each fetched member is stamped the moment its totals
 * land, and a request stops starting new members once it exhausts its wall-clock budget — the
 * 503-with-progress contract from cache.ts, so the client polls to continue. `builtAt` on the
 * org row is stamped only once no pending member remains.
 *
 * Divergences from the user cache, both deliberate:
 * - No frontier refresh: a stale org refreshes profile metadata only (1 request). Re-fetching
 *   contributions costs ~2 requests × members and belongs to the background worker.
 * - No in-memory fallback: a build spans requests, so without a database there is nothing to
 *   resume from.
 */
const ORG_TTL = 7 * 24 * 60 * 60 * 1000;

// Wall-clock budget for starting new member groups within one request — same Netlify ~10s
// rationale as cache.ts. A group of 3 members costs ~2 sequential batched queries each, ~2-4s.
const BUILD_BUDGET_MS = 6_000;

// Members fetched concurrently. Each member's window batches run sequentially inside
// fetchOrgMemberContributions, so this IS the number of GitHub queries in flight — matching
// the global CONCURRENCY cap in github.ts.
const MEMBER_CONCURRENCY = 3;

// Orgs with more visible members than this get a clean refusal instead of an on-demand build:
// at ~2 requests per member even a mid-size org lookup can eat into the shared token's hourly
// budget and poison it for every visitor. We keep this deliberately low and record the refused
// orgs (see getFromDb) so the background worker can backfill them later, off the request path.
const MAX_ORG_MEMBERS = 25;

export interface OrgSummary {
	login: string;
	name: string | null;
	avatarUrl: string;
	htmlUrl: string;
	createdAt: string;
	description: string | null;
	websiteUrl: string | null;
	location: string | null;
	twitterUsername: string | null;
	isVerified: boolean;
	/** Members visible to the token on GitHub (public members for a non-member token). */
	memberCount: number;
	publicRepos: number;
	/** org_members rows behind the totals — can lag memberCount until the next re-enumeration. */
	membersTracked: number;
	// Summed org-scoped member contributions (see org_members in schema.ts).
	totalCommits: number;
	totalPullRequests: number;
	totalReviews: number;
	totalIssues: number;
}

export function orgEntityId(login: string) {
	return `org:${login.trim().toLowerCase()}`;
}

function userEntityId(login: string) {
	return `user:${login.trim().toLowerCase()}`;
}

export async function getOrgSummary(
	login: string,
	token: string,
	now = new Date(),
): Promise<OrgSummary> {
	if (!token) {
		throw new GitHubError("No GitHub token configured on the server.", 401);
	}
	if (!db) {
		// Builds resume across requests via org_members rows — no database, nothing to resume from.
		throw new GitHubError(
			"Organization pages need a database (set DATABASE_URL).",
			500,
		);
	}
	return getFromDb(db, login, token, now);
}

type EntityRow = typeof entities.$inferSelect;

function summaryFromRow(
	row: EntityRow,
	membersTracked: number,
	now: Date,
): OrgSummary {
	return {
		login: row.login,
		name: row.name,
		avatarUrl: row.avatarUrl ?? "",
		htmlUrl: row.htmlUrl ?? `https://github.com/${row.login}`,
		createdAt: (row.createdAt ?? now).toISOString(),
		description: row.bio,
		websiteUrl: row.websiteUrl,
		location: row.location,
		twitterUsername: row.twitterUsername,
		isVerified: row.isVerified ?? false,
		memberCount: row.memberCount ?? 0,
		publicRepos: row.publicRepos ?? 0,
		membersTracked,
		totalCommits: row.totalCommits,
		totalPullRequests: row.totalPullRequests ?? 0,
		totalReviews: row.totalReviews ?? 0,
		totalIssues: row.totalIssues ?? 0,
	};
}

async function getFromDb(
	database: DB,
	login: string,
	token: string,
	now: Date,
): Promise<OrgSummary> {
	const id = orgEntityId(login);
	const nowMs = now.getTime();

	let [row] = await database
		.select()
		.from(entities)
		.where(eq(entities.id, id))
		.limit(1);

	if (!row) {
		// First sighting: the profile fetch validates the login and yields the node id (keys every
		// org-scoped contribution query) + createdAt (caps member windows). Record the profile
		// (a single cheap upsert into `entities`, builtAt still null) BEFORE refusing an oversized
		// org — this leaves a tracked row the background worker can later backfill, instead of
		// discarding the lookup. The request path still won't build it live.
		const profile = await fetchOrgProfile(login, token);
		row = await upsertOrgProfile(database, id, profile, now);
		// Record the lookup before the size check so even an oversized org we refuse to build
		// still surfaces in "recently looked up" — the row exists and the strip links to /$user.
		await recordLookup(database, id, now);
		assertBuildable(profile);
	} else {
		// Known org, revisited: bump its recency so it re-sorts to the front of the strip.
		await recordLookup(database, id, now);
	}

	const complete = row.builtAt != null;
	const fresh = row.lastFetched && nowMs - row.lastFetched.getTime() < ORG_TTL;

	if (complete && fresh) {
		return summaryFromRow(row, await memberRowCount(database, id), now);
	}

	if (complete) {
		// Stale: refresh the mutable profile metadata (verified badge, member count, description…)
		// — one cheap request. Contribution totals stay until the background worker re-fetches
		// them; a full member re-fetch is far too heavy for the request path.
		try {
			const profile = await fetchOrgProfile(login, token);
			row = await upsertOrgProfile(database, id, profile, now);
		} catch {
			/* keep the stored profile — totals still serve */
		}
		return summaryFromRow(row, await memberRowCount(database, id), now);
	}

	// ── Initial build (builtAt null) — resumes here on every poll ──────────────

	// The node id / createdAt anchor every member fetch. Rows created by this module always
	// carry them; self-heal with a profile fetch if a legacy/foreign row doesn't.
	if (!row.githubNodeId || !row.createdAt) {
		const profile = await fetchOrgProfile(login, token);
		assertBuildable(profile);
		row = await upsertOrgProfile(database, id, profile, now);
	}
	const orgNodeId = row.githubNodeId;
	const orgCreatedAt = row.createdAt;
	if (!orgNodeId || !orgCreatedAt) {
		throw new GitHubError(`Could not resolve "${login}" on GitHub.`, 502);
	}

	// Enrolled but oversized: the row is recorded for the worker, but the request path must refuse
	// it — cheaply, from the stored memberCount, so a repeat lookup never pays to re-enumerate its
	// members before bailing. (assertBuildable already caught it at first sighting.)
	if ((row.memberCount ?? 0) > MAX_ORG_MEMBERS) {
		throw new GitHubError(tooLargeMessage(login, row.memberCount ?? 0), 422);
	}

	// Enumerate members once per build: every member becomes a pending org_members row, which
	// doubles as the resume marker. Re-enumeration (membership drift) is the worker's job.
	if ((await memberRowCount(database, id)) === 0) {
		const members = await fetchOrgMembers(login, token);
		if (members.length > MAX_ORG_MEMBERS) {
			throw new GitHubError(tooLargeMessage(login, members.length), 422);
		}
		await insertPendingMembers(database, id, members);
	}

	const pending = await database
		.select({
			memberId: orgMembers.memberId,
			login: entities.login,
			createdAt: entities.createdAt,
		})
		.from(orgMembers)
		.innerJoin(entities, eq(entities.id, orgMembers.memberId))
		.where(and(eq(orgMembers.orgId, id), isNull(orgMembers.lastFetched)))
		.orderBy(orgMembers.memberId);

	const membersTotal = await memberRowCount(database, id);
	let done = membersTotal - pending.length;

	const startedAt = Date.now();
	for (let i = 0; i < pending.length; i += MEMBER_CONCURRENCY) {
		if (i > 0 && Date.now() - startedAt > BUILD_BUDGET_MS) break;
		const group = pending.slice(i, i + MEMBER_CONCURRENCY);
		await Promise.all(
			group.map(async (member) => {
				// A member can't have contributed to the org before either account existed.
				const start = new Date(
					Math.max(
						orgCreatedAt.getTime(),
						member.createdAt?.getTime() ?? orgCreatedAt.getTime(),
					),
				);
				let totals = { commits: 0, issues: 0, pullRequests: 0, reviews: 0 };
				try {
					totals = await fetchOrgMemberContributions(
						member.login,
						orgNodeId,
						token,
						yearlyWindows(start, now),
					);
				} catch (err) {
					// A deleted/renamed member 404s forever — record zeros and move on, or the
					// build would stall on it every poll. Anything else (rate limit, 5xx) aborts
					// the request; progress so far is stamped, the next poll resumes.
					if (!(err instanceof GitHubError && err.status === 404)) throw err;
				}
				await database
					.update(orgMembers)
					.set({ ...totals, lastFetched: now })
					.where(
						and(
							eq(orgMembers.orgId, id),
							eq(orgMembers.memberId, member.memberId),
						),
					);
				done += 1;
			}),
		);
	}

	if (done < membersTotal) {
		// Out of budget with members left. Reuses the user build's progress contract (the fields
		// read "months" but are plain counters) so the client polls to continue.
		throw new GitHubError(
			`Still building ${row.login}'s numbers (${membersTotal} members) — try again in a few seconds to continue.`,
			503,
			{ monthsFetched: done, monthsTotal: membersTotal },
		);
	}

	// Every member stored — roll up and stamp builtAt (same "only a finished build may look
	// finished" rule as persistEntity in cache.ts).
	const totals = await rollUpTotals(database, id, now);
	return summaryFromRow(
		{ ...row, ...totals, builtAt: now, lastFetched: now },
		membersTotal,
		now,
	);
}

function assertBuildable(profile: OrgProfile) {
	if (profile.memberCount > MAX_ORG_MEMBERS) {
		throw new GitHubError(
			tooLargeMessage(profile.login, profile.memberCount),
			422,
		);
	}
}

function tooLargeMessage(login: string, count: number) {
	return `"${login}" has ${count.toLocaleString()} public members — too many for an on-demand build yet.`;
}

async function memberRowCount(database: DB, id: string): Promise<number> {
	const [row] = await database
		.select({ n: sql<number>`count(*)` })
		.from(orgMembers)
		.where(eq(orgMembers.orgId, id));
	return Number(row?.n ?? 0);
}

/** Insert/refresh the org's profile columns only — never touches totals or builtAt. */
async function upsertOrgProfile(
	database: DB,
	id: string,
	profile: OrgProfile,
	now: Date,
): Promise<EntityRow> {
	const profileCols = {
		name: profile.name,
		avatarUrl: profile.avatarUrl,
		bio: profile.description,
		location: profile.location,
		websiteUrl: profile.websiteUrl,
		twitterUsername: profile.twitterUsername,
		publicRepos: profile.publicRepos,
		isVerified: profile.isVerified,
		githubNodeId: profile.nodeId,
		memberCount: profile.memberCount,
		// Unlike the user cache (where persistEntity stamps it), orgs bump lastFetched on the
		// profile refresh itself — it's the only refresh a built org gets on the request path.
		lastFetched: now,
	};
	const [row] = await database
		.insert(entities)
		.values({
			id,
			kind: "org",
			login: profile.login,
			htmlUrl: profile.htmlUrl,
			createdAt: new Date(profile.createdAt),
			...profileCols,
		})
		.onConflictDoUpdate({ target: entities.id, set: profileCols })
		.returning();
	return row;
}

const STUB_CHUNK = 100;

/**
 * Store the enumerated membership: a minimal `entities` stub per member (FK target — insert-only,
 * an already-tracked user's row is never touched, and a stub never triggers a user history build)
 * plus a pending `org_members` row per member.
 */
async function insertPendingMembers(
	database: DB,
	orgId: string,
	members: OrgMember[],
) {
	for (let i = 0; i < members.length; i += STUB_CHUNK) {
		const chunk = members.slice(i, i + STUB_CHUNK);
		await database
			.insert(entities)
			.values(
				chunk.map((m) => ({
					id: userEntityId(m.login),
					kind: "user",
					login: m.login,
					name: m.name,
					avatarUrl: m.avatarUrl,
					htmlUrl: `https://github.com/${m.login}`,
					createdAt: new Date(m.createdAt),
				})),
			)
			.onConflictDoNothing();
		await database
			.insert(orgMembers)
			.values(
				chunk.map((m) => ({
					orgId,
					memberId: userEntityId(m.login),
					role: m.role,
					source: "public_member",
				})),
			)
			.onConflictDoNothing();
	}
}

interface OrgTotals {
	totalCommits: number;
	totalPullRequests: number;
	totalReviews: number;
	totalIssues: number;
}

/** Sum org_members into the org's entity totals and stamp builtAt — the build's final step. */
async function rollUpTotals(
	database: DB,
	id: string,
	now: Date,
): Promise<OrgTotals> {
	const [sums] = await database
		.select({
			commits: sql<number>`coalesce(sum(${orgMembers.commits}), 0)`,
			pullRequests: sql<number>`coalesce(sum(${orgMembers.pullRequests}), 0)`,
			reviews: sql<number>`coalesce(sum(${orgMembers.reviews}), 0)`,
			issues: sql<number>`coalesce(sum(${orgMembers.issues}), 0)`,
		})
		.from(orgMembers)
		.where(eq(orgMembers.orgId, id));
	const totals: OrgTotals = {
		totalCommits: Number(sums?.commits ?? 0),
		totalPullRequests: Number(sums?.pullRequests ?? 0),
		totalReviews: Number(sums?.reviews ?? 0),
		totalIssues: Number(sums?.issues ?? 0),
	};
	await database
		.update(entities)
		.set({ ...totals, builtAt: now, lastFetched: now })
		.where(eq(entities.id, id));
	return totals;
}
