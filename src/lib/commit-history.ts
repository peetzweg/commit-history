import { createServerFn } from "@tanstack/react-start";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	sql,
} from "drizzle-orm";
import { getCommitHistory as getCachedCommitHistory } from "#/lib/cache";
import { db } from "#/lib/db";
import { entities, lookups } from "#/lib/db/schema";
import {
	type BuildProgress,
	type CommitHistory,
	GitHubError,
} from "#/lib/github";

/**
 * Server function: resolves a username's lifetime commit history.
 *
 * The GitHub token lives only on the server (env `GITHUB_TOKEN`), so it is never shipped to the
 * client. For the MVP a single PAT serves every public-username request; see README for the
 * scaling path (per-user OAuth / GitHub App).
 *
 * NOTE: do NOT rename this file to `*.server.ts`. The `.server` suffix triggers Vite/TanStack
 * import-protection, which replaces the whole module with a mock on the client — the loader then
 * receives the mock instead of the client RPC stub, and the chart crashes with
 * "points.map is not iterable". `createServerFn` already strips the handler from the client bundle
 * on its own, so the server-only deps (cache, github, process.env) never reach the browser.
 */
function serverToken(): string {
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		throw new GitHubError(
			"Server is missing GITHUB_TOKEN. Add it to .env (see .env.example).",
			500,
		);
	}
	return token;
}

export const getCommitHistory = createServerFn({ method: "GET" })
	// Coerce non-strings instead of trusting the wire type: a crafted payload would otherwise
	// crash on .trim()/.toLowerCase() further down. An empty string fails login validation with
	// a clean 400 in the fetch layer.
	.validator((login: string) => (typeof login === "string" ? login : ""))
	.handler(async ({ data: login }): Promise<CommitHistory> => {
		return getCachedCommitHistory(login, serverToken());
	});

const MAX_USERS = 8;

/**
 * Normalize a login list: strings only, trimmed, deduped case-insensitively, capped at
 * MAX_USERS. Shared by the URL parser and the RPC validator so the server-side cap can
 * never drift from what the UI builds.
 */
function normalizeLogins(parts: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const logins: string[] = [];
	for (const part of parts) {
		if (typeof part !== "string") continue;
		const login = part.trim();
		const key = login.toLowerCase();
		if (login && !seen.has(key)) {
			seen.add(key);
			logins.push(login);
		}
	}
	return logins.slice(0, MAX_USERS);
}

/** Parse a comma-separated `$user` param into a clean, deduped, capped login list. */
export function parseLogins(raw: string): string[] {
	return normalizeLogins(decodeURIComponent(raw).split(","));
}

export interface UserResult {
	login: string;
	history: CommitHistory | null;
	error: string | null;
	// True when the entity is suspended (under investigation) — the profile is still shown, but
	// with an under-review notice. The internal reason is never sent to the client.
	suspended: boolean;
	// Position on the public-commits leaderboard (1 = most public commits), among active entities.
	// Null when there's no DB; suppressed in the UI for suspended profiles (hidden from the board).
	publicRank: number | null;
	// Non-null while the initial server-side build is still in progress — each poll of the loader
	// advances it. Mutually exclusive with `error`: a building result is progress, not a failure.
	building: BuildProgress | null;
}

export interface LeaderEntry {
	login: string;
	name: string | null;
	avatarUrl: string | null;
	totalCommits: number;
	totalRestricted: number;
	// Nullable: null on rows not yet backfilled with the per-type contribution data.
	totalIssues: number | null;
	totalPullRequests: number | null;
	totalReviews: number | null;
	totalRepos: number | null;
	followers: number | null;
}
export interface RecentEntry {
	login: string;
	name: string | null;
	avatarUrl: string | null;
}
export interface StartPageData {
	recent: RecentEntry[];
	leaderboard: LeaderEntry[];
}

export type LeaderMode =
	| "commits"
	| "prs"
	| "issues"
	| "reviews"
	| "repos"
	| "public"
	| "private"
	| "total"
	| "followers";

/**
 * Cumulative row counts revealed at each scroll step. The list is capped at the final value
 * (250) so scrolling can never dump the whole table; bigger chunks further down mean fewer
 * requests as you go (25 → +25 → +50 → +100 → +50).
 */
export const LEADERBOARD_PAGE_STOPS = [25, 50, 100, 200, 250] as const;
/** Hard ceiling on how many rows any single mode's leaderboard will serve. */
export const LEADERBOARD_MAX =
	LEADERBOARD_PAGE_STOPS[LEADERBOARD_PAGE_STOPS.length - 1];
const RECENT_LIMIT = 16;

// Ranking is done in SQL per mode so pagination stays consistent as you scroll.
async function queryLeaderboard(
	mode: LeaderMode,
	offset: number,
	limit: number,
): Promise<LeaderEntry[]> {
	if (!db) return [];
	// The column each mode ranks by. `total` is the one that isn't a single column (see below).
	const rankCol = {
		commits: entities.totalCommits,
		prs: entities.totalPullRequests,
		issues: entities.totalIssues,
		reviews: entities.totalReviews,
		repos: entities.totalRepos,
		private: entities.totalRestricted,
		followers: entities.followers,
		public: entities.totalCommits, // unused — `public` orders by a sum, handled below
		total: entities.totalCommits, // unused — `total` orders by a sum, handled below
	}[mode];
	// `total` = every contribution type summed. The per-type columns are nullable (null until a
	// row is backfilled), so COALESCE them to 0 — else the whole sum would be NULL and the row
	// would sink regardless of its commits. (totalCommits/totalRestricted are NOT NULL.)
	// NULLS LAST so not-yet-backfilled rows (null type totals / followers) sink to the bottom.
	const order =
		mode === "total"
			? desc(
					sql`${entities.totalCommits} + coalesce(${entities.totalIssues}, 0) + coalesce(${entities.totalPullRequests}, 0) + coalesce(${entities.totalReviews}, 0) + coalesce(${entities.totalRepos}, 0) + ${entities.totalRestricted}`,
				)
			: mode === "public"
				? desc(
						sql`${entities.totalCommits} + coalesce(${entities.totalIssues}, 0) + coalesce(${entities.totalPullRequests}, 0) + coalesce(${entities.totalReviews}, 0) + coalesce(${entities.totalRepos}, 0)`,
					)
				: sql`${rankCol} desc nulls last`;
	// Deterministic tiebreaker. Without it, Postgres returns tied rows in arbitrary,
	// query-to-query-different order — and since each scroll stop is a separate OFFSET query,
	// a tie group straddling a page boundary gets shuffled between fetches: some users appear
	// twice in the stitched list and others silently vanish from the board entirely.
	const tiebreak = asc(entities.id);
	const cols = {
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
	};
	const base = db.select(cols).from(entities);
	// Suspended entities (gamed/under-investigation) are hidden from every mode.
	const active = isNull(entities.suspendedAt);
	// The per-type, private and followers boards only list users with a positive count — no point
	// ranking a wall of zeros, and it naturally excludes not-yet-backfilled (null) rows. `commits`,
	// `public` and `total` list everyone active.
	const positive = {
		prs: entities.totalPullRequests,
		issues: entities.totalIssues,
		reviews: entities.totalReviews,
		repos: entities.totalRepos,
		private: entities.totalRestricted,
		followers: entities.followers,
	}[mode as "prs" | "issues" | "reviews" | "repos" | "private" | "followers"];
	const scoped = positive
		? base.where(and(active, gt(positive, 0)))
		: base.where(active);
	return scoped.orderBy(order, tiebreak).limit(limit).offset(offset);
}

async function queryRecent(limit: number): Promise<RecentEntry[]> {
	if (!db) return [];
	const rows = await db
		.select({
			login: entities.login,
			name: entities.name,
			avatarUrl: entities.avatarUrl,
			last: sql<string>`max(${lookups.searchedAt})`,
		})
		.from(lookups)
		.innerJoin(entities, eq(entities.id, lookups.entityId))
		.where(isNull(entities.suspendedAt))
		.groupBy(entities.id)
		.orderBy(desc(sql`max(${lookups.searchedAt})`))
		.limit(limit);
	return rows.map((r) => ({
		login: r.login,
		name: r.name,
		avatarUrl: r.avatarUrl,
	}));
}

/**
 * GitHub star count for this project, shown in the header. Fetched server-side (with the PAT when
 * present, to dodge the low unauthenticated rate limit) and returns null on any failure so the
 * header just omits the count rather than breaking.
 */
export const getRepoStars = createServerFn({ method: "GET" }).handler(
	async (): Promise<number | null> => {
		try {
			const res = await fetch(
				"https://api.github.com/repos/peetzweg/commit-history",
				{
					headers: {
						Accept: "application/vnd.github+json",
						"User-Agent": "commit-history.com",
						...(process.env.GITHUB_TOKEN
							? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
							: {}),
					},
				},
			);
			if (!res.ok) return null;
			const data = (await res.json()) as { stargazers_count?: number };
			return typeof data.stargazers_count === "number"
				? data.stargazers_count
				: null;
		} catch {
			return null;
		}
	},
);

/** First-paint data for the start page: recent lookups + leaderboard page 1 (Commits). */
export const getStartPageData = createServerFn({ method: "GET" }).handler(
	async (): Promise<StartPageData> => {
		const [recent, leaderboard] = await Promise.all([
			queryRecent(RECENT_LIMIT),
			queryLeaderboard("commits", 0, LEADERBOARD_PAGE_STOPS[0]),
		]);
		return { recent, leaderboard };
	},
);

/** One page of the leaderboard for a given mode — drives infinite scroll. */
export const getLeaderboard = createServerFn({ method: "GET" })
	.validator((p: { mode: LeaderMode; offset: number; limit: number }) => p)
	.handler(({ data }): Promise<LeaderEntry[]> => {
		// Hard cap regardless of client-supplied params: nobody dumps the whole table by
		// hand-crafting an offset/limit. Clamp so we never read past LEADERBOARD_MAX.
		const offset = Math.min(Math.max(0, data.offset), LEADERBOARD_MAX);
		const limit = Math.min(Math.max(0, data.limit), LEADERBOARD_MAX - offset);
		return queryLeaderboard(data.mode, offset, limit);
	});

/** Recent lookups — polled for the live "Recently looked up" strip. */
export const getRecentLookups = createServerFn({ method: "GET" }).handler(
	(): Promise<RecentEntry[]> => queryRecent(RECENT_LIMIT),
);

/** Which of these logins are currently suspended (lower-cased). Empty without a DB. */
async function suspendedSet(logins: string[]): Promise<Set<string>> {
	if (!db || logins.length === 0) return new Set();
	const ids = logins.map((l) => `user:${l.trim().toLowerCase()}`);
	const rows = await db
		.select({ login: entities.login })
		.from(entities)
		.where(and(inArray(entities.id, ids), isNotNull(entities.suspendedAt)));
	return new Set(rows.map((r) => r.login.toLowerCase()));
}

/**
 * Public-leaderboard position for a user with `publicCommits` public commits: how many active
 * entities sit ahead of them, plus one. Same ordering as the "public" leaderboard (`total_commits`
 * DESC), so the number matches where you'd land on the start page. Ties share a rank — two users
 * with equal commits both count the same crowd ahead. Null without a DB.
 */
async function publicRankFor(publicCommits: number): Promise<number | null> {
	if (!db) return null;
	const [row] = await db
		.select({ ahead: sql<number>`count(*)` })
		.from(entities)
		.where(
			and(
				isNull(entities.suspendedAt),
				gt(entities.totalCommits, publicCommits),
			),
		);
	return Number(row?.ahead ?? 0) + 1;
}

/**
 * Resolve several users' histories in one round-trip, tolerating partial failure so one bad
 * username doesn't sink the whole comparison.
 */
export const getCommitHistories = createServerFn({ method: "GET" })
	// The client normally sends the loader's already-parsed list, but the RPC endpoint is public:
	// without re-normalizing here, a hand-crafted request with hundreds of logins fans out that
	// many GitHub fetches on the shared token (secondary-rate-limit → token poisoned for every
	// visitor). Never trust the array to be small, deduped, or even strings.
	.validator((logins: string[]) =>
		normalizeLogins(Array.isArray(logins) ? logins : []),
	)
	.handler(async ({ data: logins }): Promise<UserResult[]> => {
		const token = serverToken();
		// allSettled (not all): one user's failed GitHub fetch must not reject the whole batch and
		// blank out the others. suspendedSet is fetched alongside and is best-effort — a DB hiccup
		// there shouldn't drop already-loaded profiles, so it falls back to "none suspended".
		const [settled, suspended] = await Promise.all([
			Promise.allSettled(
				logins.map((login) => getCachedCommitHistory(login, token)),
			),
			suspendedSet(logins).catch(() => new Set<string>()),
		]);
		return Promise.all(
			settled.map(async (outcome, i): Promise<UserResult> => {
				const login = logins[i];
				const isSuspended = suspended.has(login.toLowerCase());
				if (outcome.status === "rejected") {
					const e = outcome.reason;
					// The 503 "still building" rejection carries progress — surface it as `building`
					// (with error null) so the client polls to continue instead of showing a failure
					// card. This mapping runs server-side, in-process, so instanceof sees the raw reason.
					const building =
						e instanceof GitHubError && e.status === 503 && e.progress
							? e.progress
							: null;
					return {
						login,
						history: null,
						error: building
							? null
							: e instanceof Error
								? e.message
								: "Failed to load",
						suspended: isSuspended,
						publicRank: null,
						building,
					};
				}
				const history = outcome.value;
				// Rank is supplementary — never let a ranking-query failure drop a loaded profile.
				const publicRank = await publicRankFor(history.total).catch(() => null);
				return {
					login,
					history,
					error: null,
					suspended: isSuspended,
					publicRank,
					building: null,
				};
			}),
		);
	});
