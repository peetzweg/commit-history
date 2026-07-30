import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import { entities, monthlyCommits } from "#/lib/db/schema";
import type { MonthlyCount } from "#/lib/github";
import { createJobLock, LOCK_KEYS } from "#/lib/job-runner";
import {
	activeRankedUser,
	metricOrder,
	metricPositiveColumn,
	metricTiebreak,
} from "#/lib/leaderboard-rank";
import type {
	MonthlyRefreshStore,
	RefreshCandidate,
	UserRefreshMetric,
} from "#/lib/monthly-user-refresh";

export function createMonthlyUserRefreshStore(
	database: DB,
): MonthlyRefreshStore {
	const lock = createJobLock(
		database,
		...LOCK_KEYS.monthlyUserRefresh,
		"monthly-user-refresh",
	);

	return {
		tryLock: lock.tryLock,
		releaseLock: lock.releaseLock,

		async usersForMetric(metric, limit) {
			return usersForMetric(database, metric, limit);
		},

		async countMissingMonth(ids, month) {
			if (ids.length === 0) return 0;
			const [row] = await database
				.select({ n: sql<number>`count(*)` })
				.from(entities)
				.where(
					and(
						inArray(entities.id, ids),
						sql`not exists (select 1 from ${monthlyCommits} mc where mc.entity_id = ${entities.id} and mc.month = ${month})`,
					),
				);
			return Number(row?.n ?? 0);
		},

		async hasMonth(id, month) {
			const [row] = await database
				.select({ entityId: monthlyCommits.entityId })
				.from(monthlyCommits)
				.where(
					and(eq(monthlyCommits.entityId, id), eq(monthlyCommits.month, month)),
				)
				.limit(1);
			return row != null;
		},

		async upsertMonth(id, month, counts) {
			await database
				.insert(monthlyCommits)
				.values({
					entityId: id,
					month,
					commits: counts.commits,
					restricted: counts.restricted,
					issues: counts.issues,
					pullRequests: counts.pullRequests,
					reviews: counts.reviews,
					repos: counts.repos,
				})
				.onConflictDoUpdate({
					target: [monthlyCommits.entityId, monthlyCommits.month],
					set: {
						commits: sql`excluded.commits`,
						restricted: sql`excluded.restricted`,
						issues: sql`excluded.issues`,
						pullRequests: sql`excluded.pull_requests`,
						reviews: sql`excluded.reviews`,
						repos: sql`excluded.repos`,
					},
				});
		},

		async recomputeTotals(id, fetchedAt) {
			const row = await monthlyTotals(database, id);
			// `last_fetched` is the contribution-month freshness marker for this worker. It does
			// not mean profile metadata was refreshed; profile columns stay on-demand/manual.
			//
			// commits/restricted are NOT NULL and the app's own tail refresh already restamps
			// total_commits from the month rows, so summing them here is the same operation.
			//
			// The four per-type columns are different: NULL means "never backfilled", and a
			// not-yet-backfilled user's month rows sit at 0 (see the monthly_commits schema note
			// and `persistEntity` in cache.ts, which refuses to write these on a tail refresh for
			// exactly this reason). Summing those would replace "unknown" with a fabricated small
			// number AND retire the marker `pnpm backfill` selects on, so the user could never be
			// repaired. Leave NULL as NULL and let the backfill own it.
			await database
				.update(entities)
				.set({
					totalCommits: row.totals.commits,
					totalRestricted: row.totals.restricted,
					lastFetched: fetchedAt,
					...(row.backfilled.issues ? { totalIssues: row.totals.issues } : {}),
					...(row.backfilled.pullRequests
						? { totalPullRequests: row.totals.pullRequests }
						: {}),
					...(row.backfilled.reviews
						? { totalReviews: row.totals.reviews }
						: {}),
					...(row.backfilled.repos ? { totalRepos: row.totals.repos } : {}),
				})
				.where(eq(entities.id, id));
			return row.totals;
		},
	};
}

async function usersForMetric(
	database: DB,
	metric: UserRefreshMetric,
	limit: number,
): Promise<RefreshCandidate[]> {
	// Same population, order and tiebreak as the metric's leaderboard — the cohort is defined as
	// "the top N of each board", so any divergence here means a visible user never gets refreshed.
	const active = activeRankedUser();
	const positive = metricPositiveColumn(metric);
	return database
		.select({ id: entities.id, login: entities.login })
		.from(entities)
		.where(positive ? and(active, gt(positive, 0)) : active)
		.orderBy(metricOrder(metric), metricTiebreak())
		.limit(limit);
}

/**
 * One round-trip for both halves of the recompute decision: the summed month rows, and which
 * per-type totals have ever been backfilled (grouping by the PK lets us select the entity's own
 * columns alongside the aggregates).
 */
async function monthlyTotals(
	database: DB,
	id: string,
): Promise<{
	totals: MonthlyCount;
	backfilled: Record<"issues" | "pullRequests" | "reviews" | "repos", boolean>;
}> {
	const [row] = await database
		.select({
			commits: sql<number>`coalesce(sum(${monthlyCommits.commits}), 0)`,
			restricted: sql<number>`coalesce(sum(${monthlyCommits.restricted}), 0)`,
			issues: sql<number>`coalesce(sum(${monthlyCommits.issues}), 0)`,
			pullRequests: sql<number>`coalesce(sum(${monthlyCommits.pullRequests}), 0)`,
			reviews: sql<number>`coalesce(sum(${monthlyCommits.reviews}), 0)`,
			repos: sql<number>`coalesce(sum(${monthlyCommits.repos}), 0)`,
			issuesBackfilled: isNotNull(entities.totalIssues),
			prsBackfilled: isNotNull(entities.totalPullRequests),
			reviewsBackfilled: isNotNull(entities.totalReviews),
			reposBackfilled: isNotNull(entities.totalRepos),
		})
		.from(entities)
		.leftJoin(monthlyCommits, eq(monthlyCommits.entityId, entities.id))
		.where(eq(entities.id, id))
		.groupBy(entities.id);

	return {
		totals: {
			commits: Number(row?.commits ?? 0),
			restricted: Number(row?.restricted ?? 0),
			issues: Number(row?.issues ?? 0),
			pullRequests: Number(row?.pullRequests ?? 0),
			reviews: Number(row?.reviews ?? 0),
			repos: Number(row?.repos ?? 0),
		},
		backfilled: {
			issues: Boolean(row?.issuesBackfilled),
			pullRequests: Boolean(row?.prsBackfilled),
			reviews: Boolean(row?.reviewsBackfilled),
			repos: Boolean(row?.reposBackfilled),
		},
	};
}
