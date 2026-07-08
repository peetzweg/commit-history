/**
 * Lifetime-totals backfill for organizations the request path won't build on demand.
 *
 * After #103, an org with more than MAX_ORG_MEMBERS (25) public members is *recorded* on lookup
 * (an `entities` row, `builtAt` null) but never built live — building a mega-org on a page request
 * would burn the shared token's hourly budget. This script fills those recorded-but-empty orgs
 * (and any org you name explicitly, e.g. google/microsoft/github) with the SAME numbers the
 * request path produces for small orgs: each public member's lifetime contributions *to that org*,
 * summed. It writes only the existing tables — `org_members` rows + the `entities` roll-up — so it
 * needs NO database migration. (The per-month resolution / company chart is separate future work
 * on the refresh-orgs worker; this deliberately does none of that.)
 *
 * Politeness: paced well under GitHub's 5,000 points/hour with a reserved floor for live traffic,
 * same model as backfill-contributions.ts. Run with bun (auto-loads .env; beware a shell-exported
 * GITHUB_TOKEN overriding it — prefix with `env -u GITHUB_TOKEN` if your shell sets one):
 *
 *   bun scripts/backfill-orgs.ts                       # every recorded org not yet filled, stalest first
 *   bun scripts/backfill-orgs.ts google microsoft      # these orgs specifically (records them if new)
 *
 * Safe to re-run and interrupt: every write is an idempotent upsert, a member already fetched in
 * this run is skipped on resume, and an org's `builtAt` is stamped only after all its members are
 * fetched (so an interrupted org stays unfilled and is retried).
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/lib/db";
import { entities, orgMembers } from "#/lib/db/schema";
import {
	fetchOrgMembers,
	fetchOrgMemberContributions,
	fetchOrgProfile,
	GitHubError,
	type OrgMemberTotals,
	yearlyWindows,
} from "#/lib/github";

if (!process.env.DATABASE_URL)
	throw new Error("DATABASE_URL is required (add it to .env)");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required (add it to .env)");
if (!db) throw new Error("Database client failed to initialise.");
const token = GITHUB_TOKEN;
const database = db;

const orgEntityId = (login: string) => `org:${login.trim().toLowerCase()}`;
const userEntityId = (login: string) => `user:${login.trim().toLowerCase()}`;

// Requests/hour we aim to spend (≈ GraphQL points), well under the 5,000/hr limit so the live
// site keeps working. Override with REFRESH_RATE=<n>.
const TARGET_RATE = Number(process.env.REFRESH_RATE ?? 2500);
// Never let the remaining budget drop below this — headroom for live traffic.
const REMAINING_FLOOR = 500;
const CHUNK_ROWS = 100;
// fetchOrgMemberContributions batches windows this many at a time; used only to pace, not for
// correctness — an over-estimate just spends the budget more conservatively.
const WINDOWS_PER_REQUEST = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RateLimit {
	remaining: number;
	resetAt: string;
}

/** Query GitHub's current rate-limit budget. `rateLimit` queries themselves cost 0 points. */
async function rateLimit(): Promise<RateLimit | null> {
	try {
		const res = await fetch("https://api.github.com/graphql", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "commit-history-backfill-orgs",
			},
			body: JSON.stringify({
				query: "query { rateLimit { remaining resetAt } }",
			}),
		});
		const json = (await res.json()) as { data?: { rateLimit: RateLimit } };
		return json.data?.rateLimit ?? null;
	} catch {
		return null;
	}
}

/** If we're near the reserved floor, sleep until GitHub's window resets (plus a small buffer). */
async function respectFloor(): Promise<void> {
	const rl = await rateLimit();
	if (!rl) return;
	if (rl.remaining > REMAINING_FLOOR) return;
	const waitMs = Math.max(0, new Date(rl.resetAt).getTime() - Date.now()) + 2000;
	console.log(
		`… budget low (${rl.remaining} left) — pausing ${Math.ceil(waitMs / 1000)}s until reset`,
	);
	await sleep(waitMs);
}

/**
 * Fill one org with lifetime totals. Returns the (approximate) number of GitHub requests spent.
 * Re-fetches the profile, (re-)enumerates members, fetches each member's org-scoped lifetime
 * totals, then rolls the sums onto the org's `entities` row and stamps `builtAt`.
 */
async function fillOrg(login: string): Promise<number> {
	const orgId = orgEntityId(login);
	const runStart = new Date();
	let requests = 0;
	console.log(`${login}: resolving profile…`);

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

	// Enumerate members → a user stub (FK target, never overwrites a real user row) + a pending
	// org_members row each. Both idempotent.
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

	// Resume support: skip members already fetched since this run started.
	const existing = await database
		.select({
			memberId: orgMembers.memberId,
			lastFetched: orgMembers.lastFetched,
		})
		.from(orgMembers)
		.where(eq(orgMembers.orgId, orgId));
	const fetchedById = new Map(existing.map((r) => [r.memberId, r.lastFetched]));
	const already = members.filter((m) => {
		const p = fetchedById.get(userEntityId(m.login));
		return p && p >= runStart;
	}).length;
	console.log(
		`  ${members.length} public members${already ? ` (${already} already done this run)` : ""} — fetching lifetime totals, ~${Math.round((Math.max(1, Math.ceil(20 / WINDOWS_PER_REQUEST)) / TARGET_RATE) * 3600)}s each`,
	);

	let done = 0;
	for (const m of members) {
		const memberId = userEntityId(m.login);
		const prev = fetchedById.get(memberId);
		if (prev && prev >= runStart) continue;

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
			// A deleted/renamed member 404s forever — record zeros and move on.
			if (!(e instanceof GitHubError && e.status === 404)) throw e;
		}
		const req = Math.max(1, Math.ceil(windows.length / WINDOWS_PER_REQUEST));
		requests += req;

		await database
			.update(orgMembers)
			.set({ ...totals, lastFetched: new Date() })
			.where(
				and(eq(orgMembers.orgId, orgId), eq(orgMembers.memberId, memberId)),
			);
		done += 1;
		console.log(
			`  ✓ ${m.login.padEnd(22)} ${totals.commits.toLocaleString()} commits  (${done}/${members.length})`,
		);
		// Politeness pacing: spread this member's request cost across the target hourly rate.
		await sleep((req / TARGET_RATE) * 3_600_000);
	}

	// Roll up org totals from org_members (departed rows, if any, stay frozen — same as #97) and
	// stamp builtAt so the org now looks finished to the request path.
	const [sums] = await database
		.select({
			commits: sql<number>`coalesce(sum(${orgMembers.commits}), 0)`,
			pullRequests: sql<number>`coalesce(sum(${orgMembers.pullRequests}), 0)`,
			reviews: sql<number>`coalesce(sum(${orgMembers.reviews}), 0)`,
			issues: sql<number>`coalesce(sum(${orgMembers.issues}), 0)`,
		})
		.from(orgMembers)
		.where(eq(orgMembers.orgId, orgId));
	await database
		.update(entities)
		.set({
			totalCommits: Number(sums?.commits ?? 0),
			totalPullRequests: Number(sums?.pullRequests ?? 0),
			totalReviews: Number(sums?.reviews ?? 0),
			totalIssues: Number(sums?.issues ?? 0),
			builtAt: new Date(),
			lastFetched: new Date(),
		})
		.where(eq(entities.id, orgId));

	console.log(
		`✓ ${login.padEnd(24)} ${Number(sums?.commits ?? 0).toLocaleString()} commits · ${done}/${members.length} members fetched`,
	);
	return requests;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));

let targets: { login: string }[];
if (args.length > 0) {
	targets = args.map((login) => ({ login }));
	console.log(`Backfilling ${targets.length} org(s) by name\n`);
} else {
	// Every recorded-but-unfilled org (builtAt null), stalest first; an interrupted org keeps its
	// old lastFetched and is retried first.
	const rows = await database
		.select({ login: entities.login })
		.from(entities)
		.where(and(eq(entities.kind, "org"), isNull(entities.builtAt)))
		.orderBy(sql`${entities.lastFetched} asc nulls first`, asc(entities.id));
	targets = rows;
	console.log(
		`${rows.length} recorded org(s) not yet filled, stalest first, ~${TARGET_RATE} req/hr\n`,
	);
}

let spent = 0;
for (const { login } of targets) {
	await respectFloor();
	try {
		spent += await fillOrg(login);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`✗ ${login.padEnd(24)} ${msg} — continuing`);
	}
}
console.log(`\nDone. ~${spent.toLocaleString()} requests spent.`);
