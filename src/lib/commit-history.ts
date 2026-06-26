import { createServerFn } from "@tanstack/react-start";
import { desc, eq, gt, sql } from "drizzle-orm";
import { getCommitHistory as getCachedCommitHistory } from "#/lib/cache";
import { db } from "#/lib/db";
import { entities, lookups } from "#/lib/db/schema";
import { type CommitHistory, GitHubError } from "#/lib/github";

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
	.validator((login: string) => login)
	.handler(async ({ data: login }): Promise<CommitHistory> => {
		return getCachedCommitHistory(login, serverToken());
	});

const MAX_USERS = 8;

/** Parse a comma-separated `$user` param into a clean, deduped, capped login list. */
export function parseLogins(raw: string): string[] {
	const seen = new Set<string>();
	const logins: string[] = [];
	for (const part of decodeURIComponent(raw).split(",")) {
		const login = part.trim();
		const key = login.toLowerCase();
		if (login && !seen.has(key)) {
			seen.add(key);
			logins.push(login);
		}
	}
	return logins.slice(0, MAX_USERS);
}

export interface UserResult {
	login: string;
	history: CommitHistory | null;
	error: string | null;
}

export interface LeaderEntry {
	login: string;
	name: string | null;
	avatarUrl: string | null;
	totalCommits: number;
	totalRestricted: number;
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

export type LeaderMode = "public" | "private" | "both" | "followers";

export const LEADERBOARD_PAGE_SIZE = 20;
const RECENT_LIMIT = 16;

// Ranking is done in SQL per mode so pagination stays consistent as you scroll.
async function queryLeaderboard(
	mode: LeaderMode,
	offset: number,
	limit: number,
): Promise<LeaderEntry[]> {
	if (!db) return [];
	const order =
		mode === "public"
			? desc(entities.totalCommits)
			: mode === "private"
				? desc(entities.totalRestricted)
				: mode === "followers"
					? // NULLS LAST so not-yet-backfilled rows sink to the bottom.
						sql`${entities.followers} desc nulls last`
					: desc(sql`${entities.totalCommits} + ${entities.totalRestricted}`);
	const cols = {
		login: entities.login,
		name: entities.name,
		avatarUrl: entities.avatarUrl,
		totalCommits: entities.totalCommits,
		totalRestricted: entities.totalRestricted,
		followers: entities.followers,
	};
	const base = db.select(cols).from(entities);
	// Private mode only lists users who expose private contributions; followers mode only those
	// with a known follower count.
	const scoped =
		mode === "private"
			? base.where(gt(entities.totalRestricted, 0))
			: mode === "followers"
				? base.where(gt(entities.followers, 0))
				: base;
	return scoped.orderBy(order).limit(limit).offset(offset);
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
		.groupBy(entities.id)
		.orderBy(desc(sql`max(${lookups.searchedAt})`))
		.limit(limit);
	return rows.map((r) => ({
		login: r.login,
		name: r.name,
		avatarUrl: r.avatarUrl,
	}));
}

/** First-paint data for the start page: recent lookups + leaderboard page 1 (Both). */
export const getStartPageData = createServerFn({ method: "GET" }).handler(
	async (): Promise<StartPageData> => {
		const [recent, leaderboard] = await Promise.all([
			queryRecent(RECENT_LIMIT),
			queryLeaderboard("public", 0, LEADERBOARD_PAGE_SIZE),
		]);
		return { recent, leaderboard };
	},
);

/** One page of the leaderboard for a given mode — drives infinite scroll. */
export const getLeaderboard = createServerFn({ method: "GET" })
	.validator((p: { mode: LeaderMode; offset: number; limit: number }) => p)
	.handler(
		({ data }): Promise<LeaderEntry[]> =>
			queryLeaderboard(data.mode, data.offset, data.limit),
	);

/** Recent lookups — polled for the live "Recently looked up" strip. */
export const getRecentLookups = createServerFn({ method: "GET" }).handler(
	(): Promise<RecentEntry[]> => queryRecent(RECENT_LIMIT),
);

/**
 * Resolve several users' histories in one round-trip, tolerating partial failure so one bad
 * username doesn't sink the whole comparison.
 */
export const getCommitHistories = createServerFn({ method: "GET" })
	.validator((logins: string[]) => logins)
	.handler(async ({ data: logins }): Promise<UserResult[]> => {
		const token = serverToken();
		return Promise.all(
			logins.map(async (login): Promise<UserResult> => {
				try {
					const history = await getCachedCommitHistory(login, token);
					return { login, history, error: null };
				} catch (e) {
					return {
						login,
						history: null,
						error: e instanceof Error ? e.message : "Failed to load",
					};
				}
			}),
		);
	});
