import { and, eq, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import { entities, orgMembers } from "#/lib/db/schema";
import {
	fetchOrgMemberContributions,
	fetchOrgMembers,
	fetchOrgProfile,
	GitHubError,
	type OrgMemberTotals,
	yearlyWindows,
} from "#/lib/github";

/**
 * Off-request-path fill of ONE organization: profile → member enumeration → each member's
 * org-scoped lifetime contributions → roll-up onto the org's `entities` row.
 *
 * This is the engine behind both `pnpm refresh-org <login>` (one org, on demand) and
 * `pnpm backfill-orgs` (every recorded-but-unfilled org). They differ only in how they pick
 * targets, so the actual GitHub/DB work lives here rather than in two drifting copies.
 *
 * Why it can't live on the request path: at ~1-4 GitHub requests per member, a 1,500-member org
 * is thousands of requests. org-cache.ts refuses anything over MAX_ORG_MEMBERS (25) live and
 * leaves a `builtAt`-null row for exactly this code to pick up.
 *
 * Two properties everything else depends on:
 *
 * - **Resumable.** A member's `org_members.lastFetched` is the done-marker, written the moment its
 *   totals land. An aborted run leaves the org `builtAt`-null with some members stamped; the next
 *   run skips those and continues. Every write is an idempotent upsert.
 * - **Re-enumerating.** Unlike the request-path build (which enumerates once and never again),
 *   this always re-reads `membersWithRole`, so members who joined or flipped their membership
 *   public since the last run get picked up. That is the whole point of the refresh mode.
 *
 * Departed members are reported but never deleted — see #97: dropping them would silently shrink
 * the org's lifetime totals even though GitHub still attributes those commits to the org's repos.
 */

// Never let the token's remaining budget drop below this — headroom for live traffic.
const REMAINING_FLOOR = 500;
const CHUNK_ROWS = 100;
// fetchOrgMemberContributions batches windows this many at a time; used only to pace, not for
// correctness — an over-estimate just spends the budget more conservatively.
const WINDOWS_PER_REQUEST = 6;

const orgEntityId = (login: string) => `org:${login.trim().toLowerCase()}`;
const userEntityId = (login: string) => `user:${login.trim().toLowerCase()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface OrgTotals {
	totalCommits: number;
	totalPullRequests: number;
	totalReviews: number;
	totalIssues: number;
}

export interface OrgRefreshResult {
	login: string;
	/** Public members GitHub reports right now. */
	memberCount: number;
	/** `org_members` rows after this run's enumeration. */
	tracked: number;
	/** Members enumerated for the first time by this run. */
	added: number;
	/** Tracked members GitHub no longer lists as public — kept, not deleted (#97). */
	departed: string[];
	/** Members whose contributions this run (re-)fetched. */
	fetched: number;
	/** Members left alone because they were already filled (0 when `force`). */
	skipped: number;
	/** Approximate GitHub requests spent. */
	requests: number;
	/** Totals before the roll-up — null when the org had no row yet. */
	before: OrgTotals | null;
	after: OrgTotals;
}

export interface OrgRefreshOptions {
	database: DB;
	token: string;
	login: string;
	/**
	 * Re-fetch members that already have totals instead of skipping them. Needed to pick up
	 * retroactive changes (a member turning on private-contribution visibility, new commits since
	 * the last run); without it a refresh only fills gaps.
	 */
	force?: boolean;
	/** Requests/hour to pace at — well under GitHub's 5,000/hr so the live site keeps working. */
	ratePerHour?: number;
	/** Per-member progress lines. Default: silent. */
	log?: (line: string) => void;
}

/** Query GitHub's current rate-limit budget. `rateLimit` queries themselves cost 0 points. */
export async function rateLimitBudget(
	token: string,
): Promise<{ remaining: number; resetAt: string } | null> {
	try {
		const res = await fetch("https://api.github.com/graphql", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "commit-history-org-refresh",
			},
			body: JSON.stringify({
				query: "query { rateLimit { remaining resetAt } }",
			}),
		});
		const json = (await res.json()) as {
			data?: { rateLimit: { remaining: number; resetAt: string } };
		};
		return json.data?.rateLimit ?? null;
	} catch {
		return null;
	}
}

/** If we're near the reserved floor, sleep until GitHub's window resets (plus a small buffer). */
export async function respectRateFloor(
	token: string,
	log: (line: string) => void = () => {},
): Promise<void> {
	const rl = await rateLimitBudget(token);
	if (!rl || rl.remaining > REMAINING_FLOOR) return;
	const waitMs =
		Math.max(0, new Date(rl.resetAt).getTime() - Date.now()) + 2000;
	log(
		`… budget low (${rl.remaining} left) — pausing ${Math.ceil(waitMs / 1000)}s until reset`,
	);
	await sleep(waitMs);
}

export async function refreshOrg({
	database,
	token,
	login,
	force = false,
	ratePerHour = 2500,
	log = () => {},
}: OrgRefreshOptions): Promise<OrgRefreshResult> {
	const orgId = orgEntityId(login);
	const runStart = new Date();
	let requests = 0;

	const [prior] = await database
		.select({
			totalCommits: entities.totalCommits,
			totalPullRequests: entities.totalPullRequests,
			totalReviews: entities.totalReviews,
			totalIssues: entities.totalIssues,
		})
		.from(entities)
		.where(eq(entities.id, orgId))
		.limit(1);
	const before: OrgTotals | null = prior
		? {
				totalCommits: prior.totalCommits,
				totalPullRequests: prior.totalPullRequests ?? 0,
				totalReviews: prior.totalReviews ?? 0,
				totalIssues: prior.totalIssues ?? 0,
			}
		: null;

	log(`${login}: resolving profile…`);

	// Profile first — validates the login, yields nodeId (keys every org-scoped query) + createdAt
	// (bounds each member's windows). Upsert so a never-looked-up org (e.g. a fresh google) is
	// recorded here rather than requiring a prior page visit. builtAt stays null until the roll-up.
	const profile = await fetchOrgProfile(login, token);
	requests += 1;
	const profileCols = {
		login: profile.login,
		name: profile.name,
		avatarUrl: profile.avatarUrl,
		htmlUrl: profile.htmlUrl,
		createdAt: new Date(profile.createdAt),
		bio: profile.description,
		location: profile.location,
		websiteUrl: profile.websiteUrl,
		twitterUsername: profile.twitterUsername,
		publicRepos: profile.publicRepos,
		isVerified: profile.isVerified,
		githubNodeId: profile.nodeId,
		memberCount: profile.memberCount,
		lastFetched: runStart,
	};
	await database
		.insert(entities)
		.values({ id: orgId, kind: "org", ...profileCols })
		.onConflictDoUpdate({ target: entities.id, set: profileCols });
	const orgCreated = new Date(profile.createdAt);

	// What we tracked going in — the baseline for the added/departed drift report below.
	const existing = await database
		.select({
			memberId: orgMembers.memberId,
			lastFetched: orgMembers.lastFetched,
		})
		.from(orgMembers)
		.where(eq(orgMembers.orgId, orgId));
	const fetchedById = new Map(existing.map((r) => [r.memberId, r.lastFetched]));

	// (Re-)enumerate → a user stub (FK target, never overwrites a real user row) + a pending
	// org_members row each. Both idempotent, so this picks up joiners without disturbing anyone.
	const members = await fetchOrgMembers(login, token);
	requests += Math.max(1, Math.ceil(members.length / 100));
	for (let i = 0; i < members.length; i += CHUNK_ROWS) {
		const chunk = members.slice(i, i + CHUNK_ROWS);
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

	const currentIds = new Set(members.map((m) => userEntityId(m.login)));
	const added = members.filter((m) => !fetchedById.has(userEntityId(m.login)));
	// Tracked but no longer listed: left the org, or flipped membership back to private. Their rows
	// (and their contributions) stay — see #97.
	const departed = existing
		.filter((r) => !currentIds.has(r.memberId))
		.map((r) => r.memberId.replace(/^user:/, ""));

	// A member's `lastFetched` marks it done — in this run OR a previous, aborted one. By default we
	// skip anything already fetched, so a re-run continues from exactly where an abort stopped
	// instead of restarting the org. --force re-fetches everyone, to refresh existing numbers.
	const isDone = (memberLogin: string) =>
		!force && fetchedById.get(userEntityId(memberLogin)) != null;
	const skipped = members.filter((m) => isDone(m.login)).length;
	const todo = members.length - skipped;

	log(
		`  ${members.length} public members` +
			(added.length ? ` (+${added.length} new)` : "") +
			(departed.length ? ` (−${departed.length} no longer public)` : "") +
			(skipped ? ` · ${skipped} already filled, skipping` : "") +
			` — fetching ${todo}`,
	);

	let fetched = 0;
	for (const m of members) {
		const memberId = userEntityId(m.login);
		if (isDone(m.login)) continue;

		// A member can't have contributed to the org before either account existed.
		const start = new Date(
			Math.max(orgCreated.getTime(), new Date(m.createdAt).getTime()),
		);
		const windows = yearlyWindows(start, runStart);
		let totals: OrgMemberTotals = {
			commits: 0,
			issues: 0,
			pullRequests: 0,
			reviews: 0,
		};
		try {
			totals = await fetchOrgMemberContributions(
				m.login,
				profile.nodeId,
				token,
				windows,
			);
		} catch (e) {
			// Isolate per-member failures so one bad member can't sink the whole org:
			//  - 404: deleted/renamed member — gone forever.
			//  - 400: login our validator can't accept (shouldn't happen now that legacy
			//    hyphen-ending usernames pass, but stay defensive).
			// Record zeros + mark done so resume doesn't wedge on it. Rate limits (403/429) and
			// 5xx still propagate → the run aborts and resumes later rather than storing false zeros.
			if (
				!(e instanceof GitHubError && (e.status === 404 || e.status === 400))
			) {
				throw e;
			}
			log(`  – ${m.login.padEnd(22)} skipped (${(e as GitHubError).status})`);
		}
		const req = Math.max(1, Math.ceil(windows.length / WINDOWS_PER_REQUEST));
		requests += req;

		await database
			.update(orgMembers)
			.set({ ...totals, lastFetched: new Date() })
			.where(
				and(eq(orgMembers.orgId, orgId), eq(orgMembers.memberId, memberId)),
			);
		fetched += 1;
		log(
			`  ✓ ${m.login.padEnd(22)} ${totals.commits.toLocaleString()} commits  (${fetched}/${todo})`,
		);
		// Politeness pacing: spread this member's request cost across the target hourly rate.
		await sleep((req / ratePerHour) * 3_600_000);
	}

	const after = await rollUp(database, orgId);
	const [tracked] = await database
		.select({ n: sql<number>`count(*)` })
		.from(orgMembers)
		.where(eq(orgMembers.orgId, orgId));

	return {
		login: profile.login,
		memberCount: profile.memberCount,
		tracked: Number(tracked?.n ?? 0),
		added: added.length,
		departed,
		fetched,
		skipped,
		requests,
		before,
		after,
	};
}

/**
 * Sum `org_members` into the org's entity totals and stamp `builtAt` — the run's final step, so an
 * interrupted org never looks finished. Departed rows are included on purpose (#97).
 */
async function rollUp(database: DB, orgId: string): Promise<OrgTotals> {
	const [sums] = await database
		.select({
			commits: sql<number>`coalesce(sum(${orgMembers.commits}), 0)`,
			pullRequests: sql<number>`coalesce(sum(${orgMembers.pullRequests}), 0)`,
			reviews: sql<number>`coalesce(sum(${orgMembers.reviews}), 0)`,
			issues: sql<number>`coalesce(sum(${orgMembers.issues}), 0)`,
		})
		.from(orgMembers)
		.where(eq(orgMembers.orgId, orgId));
	const totals: OrgTotals = {
		totalCommits: Number(sums?.commits ?? 0),
		totalPullRequests: Number(sums?.pullRequests ?? 0),
		totalReviews: Number(sums?.reviews ?? 0),
		totalIssues: Number(sums?.issues ?? 0),
	};
	const now = new Date();
	await database
		.update(entities)
		.set({ ...totals, builtAt: now, lastFetched: now })
		.where(eq(entities.id, orgId));
	return totals;
}
