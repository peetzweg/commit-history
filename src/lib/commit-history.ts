import { createServerFn } from "@tanstack/react-start";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	sql,
} from "drizzle-orm";
import type { ChartMode } from "#/components/CommitChart";
import { getCommitHistory as getCachedCommitHistory } from "#/lib/cache";
import { db } from "#/lib/db";
import { entities, lookups } from "#/lib/db/schema";
import {
	type BuildProgress,
	type CommitHistory,
	GitHubError,
} from "#/lib/github";
import {
	activeRankedUser,
	type LeaderMetric,
	metricOrder,
	metricPositiveColumn,
	metricTiebreak,
	metricTotalExpr,
	RANK_COLUMN,
} from "#/lib/leaderboard-rank";
import { availableMetrics, METRIC_TOTAL } from "#/lib/metrics";

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
export function serverToken(): string {
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
	// Leaderboard position per metric (1 = top), among active entities, mirroring each metric's
	// board ordering. Keyed by the metrics this profile has data for (always includes "public").
	// Empty without a DB; suppressed in the UI for suspended profiles (hidden from every board).
	ranks: Partial<Record<ChartMode, number | null>>;
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
	/** Drives the chip's avatar shape (org = square, user = circle) and the verified badge. */
	kind: "user" | "org";
	/** Org-only verified badge; null for users. */
	isVerified: boolean | null;
}
export interface StartPageData {
	recent: RecentEntry[];
	leaderboard: LeaderEntry[];
}

/** Leaderboard metric. Defined with the ranking rules in `leaderboard-rank.ts`. */
export type LeaderMode = LeaderMetric;

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
	const active = activeRankedUser();
	const positive = metricPositiveColumn(mode);
	const scoped = positive
		? base.where(and(active, gt(positive, 0)))
		: base.where(active);
	return scoped
		.orderBy(metricOrder(mode), metricTiebreak())
		.limit(limit)
		.offset(offset);
}

/**
 * How many raw lookup rows queryRecent inspects. The strip needs RECENT_LIMIT *distinct* entities,
 * so this needs headroom for repeat searches of the same login (and the odd suspended/repo row) —
 * but it must stay a constant: `lookups` is append-only and unbounded, and aggregating the whole
 * table made every strip poll scan the full search history.
 */
const RECENT_SCAN_WINDOW = 400;

async function queryRecent(limit: number): Promise<RecentEntry[]> {
	if (!db) return [];
	// Newest slice first (walks lookups_searched_at_idx, stops after the window), dedupe after.
	const recent = db
		.select({
			entityId: lookups.entityId,
			searchedAt: lookups.searchedAt,
		})
		.from(lookups)
		.orderBy(desc(lookups.searchedAt))
		.limit(RECENT_SCAN_WINDOW)
		.as("recent");
	const rows = await db
		.select({
			login: entities.login,
			name: entities.name,
			avatarUrl: entities.avatarUrl,
			kind: entities.kind,
			isVerified: entities.isVerified,
			last: sql<string>`max(${recent.searchedAt})`,
		})
		.from(recent)
		.innerJoin(entities, eq(entities.id, recent.entityId))
		// Users and orgs both belong in the strip (each links to /$user, which resolves either);
		// repos are the only other kind and don't get a page here, so they're excluded.
		.where(
			and(
				isNull(entities.suspendedAt),
				inArray(entities.kind, ["user", "org"]),
			),
		)
		.groupBy(entities.id)
		.orderBy(desc(sql`max(${recent.searchedAt})`))
		.limit(limit);
	return rows.map((r) => ({
		login: r.login,
		name: r.name,
		avatarUrl: r.avatarUrl,
		kind: r.kind === "org" ? "org" : "user",
		isVerified: r.isVerified,
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

/** First-paint data for the start page: recent lookups + leaderboard page 1 (Both). */
export const getStartPageData = createServerFn({ method: "GET" }).handler(
	async (): Promise<StartPageData> => {
		const [recent, leaderboard] = await Promise.all([
			queryRecent(RECENT_LIMIT),
			queryLeaderboard("public", 0, LEADERBOARD_PAGE_STOPS[0]),
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
 * Leaderboard position for a user with `value` in `mode`: how many active entities sit ahead of
 * them, plus one — same ordering as that metric's leaderboard, so the number matches where you'd
 * land on the board. Ties share a rank. Nullable per-type columns COALESCE to 0 (a not-yet-
 * backfilled row can't be "ahead"), and `total` compares the same summed expression the board does.
 * Null without a DB.
 */
async function metricRankFor(
	mode: ChartMode,
	value: number,
): Promise<number | null> {
	if (!db) return null;
	const ahead =
		mode === "total"
			? sql`${metricTotalExpr()} > ${value}`
			: gt(RANK_COLUMN[mode], value);
	const [row] = await db
		.select({ ahead: sql<number>`count(*)` })
		.from(entities)
		// Same population as the board itself — rank numbers must match where you'd land on it.
		.where(and(activeRankedUser(), ahead));
	return Number(row?.ahead ?? 0) + 1;
}

/** Rank in every metric this profile has data for (always includes "public"), computed in one
 *  fan-out so the client can switch metrics without a refetch. Ranking failures degrade to null. */
async function ranksFor(
	history: CommitHistory,
): Promise<Partial<Record<ChartMode, number | null>>> {
	const modes = availableMetrics([history]);
	const entries = await Promise.all(
		modes.map(
			async (m) =>
				[
					m,
					await metricRankFor(m, METRIC_TOTAL[m](history)).catch(() => null),
				] as const,
		),
	);
	return Object.fromEntries(entries);
}

/**
 * Resolve several users' histories, tolerating partial failure so one bad username doesn't sink
 * the whole comparison. Plain server-side function — exported for getLookup (org.ts), which
 * composes it with the org fallback. Server functions must NOT call each other (a server-side
 * call turns into an HTTP self-fetch), so shared logic lives here.
 */
export async function lookupUsers(rawLogins: string[]): Promise<UserResult[]> {
	// Normalize even when called server-side, so the cap/dedupe can never be bypassed.
	const logins = normalizeLogins(rawLogins);
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
					ranks: {},
					building,
				};
			}
			const history = outcome.value;
			// Ranks are supplementary — never let a ranking-query failure drop a loaded profile.
			const ranks = await ranksFor(history).catch(() => ({}));
			return {
				login,
				history,
				error: null,
				suspended: isSuspended,
				ranks,
				building: null,
			};
		}),
	);
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
	.handler(({ data: logins }): Promise<UserResult[]> => lookupUsers(logins));
