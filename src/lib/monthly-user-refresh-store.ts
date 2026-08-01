import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import { entities, monthlyCommits } from "#/lib/db/schema";
import type { MonthlyCount } from "#/lib/github";
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

const USER_REFRESH_LOCK_KEY_1 = 20260701;
const USER_REFRESH_LOCK_KEY_2 = 1;

/**
 * "This stored month is final": read at/after the month's own end. A null `fetched_at` predates the
 * column and so is explicitly NOT complete — that is what makes the pre-a44f442 partial rows
 * eligible for repair instead of being skipped forever.
 *
 * `at time zone 'UTC'` is load-bearing: `month` is a bare date, so `month + interval '1 month'` is
 * a timestamp *without* zone, and comparing it to a timestamptz would otherwise resolve against the
 * session's TimeZone and move the boundary by hours. Months here are UTC by definition.
 */
const completeMonthRow = (table: string) =>
	sql.raw(
		`${table}.fetched_at is not null and ${table}.fetched_at >= ((${table}.month + interval '1 month') at time zone 'UTC')`,
	);

export function createMonthlyUserRefreshStore(
	database: DB,
): MonthlyRefreshStore {
	// Advisory locks are SESSION-scoped, and `database.execute` takes an arbitrary connection out
	// of the postgres.js pool. Unlocking from a different connection than the one holding the lock
	// silently returns false, so the lock is pinned to a reserved connection for the run's
	// lifetime. (Mutual exclusion would work either way — a second process is a second session —
	// but a release that quietly no-ops is a trap for whoever reuses this next.)
	let lockConn: Awaited<ReturnType<DB["$client"]["reserve"]>> | null = null;

	return {
		async tryLock() {
			lockConn = await database.$client.reserve();
			const [row] = await lockConn<Array<{ acquired: boolean }>>`
				select pg_try_advisory_lock(${USER_REFRESH_LOCK_KEY_1}, ${USER_REFRESH_LOCK_KEY_2}) as acquired`;
			const acquired = Boolean(row?.acquired);
			if (!acquired) {
				lockConn.release();
				lockConn = null;
			}
			return acquired;
		},

		async releaseLock() {
			if (!lockConn) return;
			try {
				const [row] = await lockConn<Array<{ released: boolean }>>`
					select pg_advisory_unlock(${USER_REFRESH_LOCK_KEY_1}, ${USER_REFRESH_LOCK_KEY_2}) as released`;
				if (!row?.released) {
					console.warn(
						"monthly-user-refresh lock=release_returned_false (was it held by this session?)",
					);
				}
			} finally {
				lockConn.release();
				lockConn = null;
			}
		},

		async usersForMetric(metric, limit) {
			return usersForMetric(database, metric, limit);
		},

		async countIncompleteMonth(ids, month) {
			if (ids.length === 0) return 0;
			const [row] = await database
				.select({ n: sql<number>`count(*)` })
				.from(entities)
				.where(
					and(
						inArray(entities.id, ids),
						sql`not exists (
							select 1 from ${monthlyCommits} mc
							where mc.entity_id = ${entities.id}
							  and mc.month = ${month}
							  and ${completeMonthRow("mc")})`,
					),
				);
			return Number(row?.n ?? 0);
		},

		async hasCompleteMonth(id, month) {
			const [row] = await database
				.select({ entityId: monthlyCommits.entityId })
				.from(monthlyCommits)
				.where(
					and(
						eq(monthlyCommits.entityId, id),
						eq(monthlyCommits.month, month),
						completeMonthRow("monthly_commits"),
					),
				)
				.limit(1);
			return row != null;
		},

		async upsertMonth(id, month, counts, fetchedAt) {
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
					fetchedAt,
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
						fetchedAt: sql`excluded.fetched_at`,
					},
				});
		},

		async markUnreachable(id, at) {
			await database
				.update(entities)
				.set({ unreachableAt: at })
				.where(eq(entities.id, id));
		},

		async recomputeTotals(id, fetchedAt) {
			const row = await monthlyTotals(database, id);
			// `last_fetched` records that this worker touched the entity; it does NOT mean profile
			// metadata was refreshed (profile columns stay on-demand/manual), and it is NOT the
			// month-freshness gate — that is `monthly_commits.fetched_at`, which is per month row and
			// can't be bumped by an unrelated profile refresh (`scripts/refresh.ts` sets this column).
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
	//
	// One deliberate divergence: logins GitHub no longer resolves. They stay on the board (their
	// stored history was real) but there is nothing left to fetch, so refreshing them only burns a
	// request and fails the scheduled task. Filtering here rather than in `activeRankedUser()` keeps
	// the board and the rank badge unchanged — the cohort is "the top N we can still refresh", so it
	// backfills from the next user down instead of leaving a hole.
	const active = and(activeRankedUser(), isNull(entities.unreachableAt));
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
