/**
 * The single source of truth for how users are ranked.
 *
 * Three call sites must agree exactly or the product lies to people: the leaderboard itself
 * (`queryLeaderboard`), the "you are #N" badge on a profile (`metricRankFor`), and the monthly
 * refresh worker's cohort selection (`monthly-user-refresh-store.ts`), which is defined as "the
 * top N of each board". When these drifted apart, a user could sit on a board the worker never
 * refreshes. Keep every ordering/filtering decision here, not in the callers.
 *
 * Drizzle expression builders only — no `db` handle — so this module stays trivially importable
 * from the worker bundle as well as the app.
 */
import {
	type AnyColumn,
	and,
	asc,
	desc,
	eq,
	isNotNull,
	isNull,
	type SQL,
	sql,
} from "drizzle-orm";
import { entities } from "#/lib/db/schema";

/** Every user leaderboard metric, in tab order. */
export const LEADER_METRICS = [
	"public",
	"prs",
	"issues",
	"reviews",
	"repos",
	"private",
	"total",
	"followers",
] as const;

export type LeaderMetric = (typeof LEADER_METRICS)[number];

/**
 * The column each single-column metric ranks by. "total" is absent on purpose: it ranks by a
 * sum across columns, so it goes through `metricTotalExpr` instead.
 */
export const RANK_COLUMN: Record<Exclude<LeaderMetric, "total">, AnyColumn> = {
	public: entities.totalCommits,
	prs: entities.totalPullRequests,
	issues: entities.totalIssues,
	reviews: entities.totalReviews,
	repos: entities.totalRepos,
	private: entities.totalRestricted,
	followers: entities.followers,
};

/**
 * Who is eligible to be ranked at all. Suspended entities (gamed/under-investigation) are hidden
 * from every board. Users only: org rows rank on their own board, and the org build creates
 * not-yet-built user *stubs* (builtAt null, zero months) which must not pad the bottom — hence
 * the builtAt check.
 */
export function activeRankedUser(): SQL | undefined {
	return and(
		isNull(entities.suspendedAt),
		eq(entities.kind, "user"),
		isNotNull(entities.builtAt),
	);
}

/**
 * "total" = every contribution type summed. The per-type columns are nullable (null until a row
 * is backfilled), so COALESCE them to 0 — else the whole sum would be NULL and the row would sink
 * regardless of its commits. (totalCommits/totalRestricted are NOT NULL.)
 */
export function metricTotalExpr(): SQL<number> {
	return sql<number>`${entities.totalCommits} + coalesce(${entities.totalIssues}, 0) + coalesce(${entities.totalPullRequests}, 0) + coalesce(${entities.totalReviews}, 0) + coalesce(${entities.totalRepos}, 0) + ${entities.totalRestricted}`;
}

/** Ranking order for a metric. NULLS LAST so not-yet-backfilled rows sink to the bottom. */
export function metricOrder(metric: LeaderMetric): SQL {
	return metric === "total"
		? desc(metricTotalExpr())
		: sql`${RANK_COLUMN[metric]} desc nulls last`;
}

/**
 * Deterministic tiebreaker. Without it, Postgres returns tied rows in arbitrary,
 * query-to-query-different order — and since each leaderboard scroll stop is a separate OFFSET
 * query, a tie group straddling a page boundary gets shuffled between fetches: some users appear
 * twice in the stitched list and others silently vanish from the board entirely.
 */
export function metricTiebreak() {
	return asc(entities.id);
}

/**
 * The per-type, private and followers boards only list users with a positive count — no point
 * ranking a wall of zeros, and it naturally excludes not-yet-backfilled (null) rows. `public`
 * and `total` list everyone active, so they have no positivity column.
 */
export function metricPositiveColumn(
	metric: LeaderMetric,
): AnyColumn | undefined {
	return {
		prs: entities.totalPullRequests,
		issues: entities.totalIssues,
		reviews: entities.totalReviews,
		repos: entities.totalRepos,
		private: entities.totalRestricted,
		followers: entities.followers,
	}[metric as "prs" | "issues" | "reviews" | "repos" | "private" | "followers"];
}
