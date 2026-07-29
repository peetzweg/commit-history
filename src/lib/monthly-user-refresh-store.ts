import {
	type AnyColumn,
	and,
	asc,
	desc,
	eq,
	gt,
	isNotNull,
	isNull,
	sql,
} from "drizzle-orm";
import type { DB } from "#/lib/db";
import { entities, monthlyCommits } from "#/lib/db/schema";
import type { MonthlyCount } from "#/lib/github";
import type {
	MonthlyRefreshStore,
	RefreshCandidate,
	UserRefreshMetric,
} from "#/lib/monthly-user-refresh";

const USER_REFRESH_LOCK_KEY_1 = 20260701;
const USER_REFRESH_LOCK_KEY_2 = 1;

const RANK_COL: Record<Exclude<UserRefreshMetric, "total">, AnyColumn> = {
	public: entities.totalCommits,
	prs: entities.totalPullRequests,
	issues: entities.totalIssues,
	reviews: entities.totalReviews,
	repos: entities.totalRepos,
	private: entities.totalRestricted,
	followers: entities.followers,
};

export function createMonthlyUserRefreshStore(database: DB): MonthlyRefreshStore {
	return {
		async tryLock() {
			const rows = (await database.execute(
				sql`select pg_try_advisory_lock(${USER_REFRESH_LOCK_KEY_1}, ${USER_REFRESH_LOCK_KEY_2}) as acquired`,
			)) as unknown as Array<{ acquired: boolean }>;
			return Boolean(rows[0]?.acquired);
		},

		async releaseLock() {
			await database.execute(
				sql`select pg_advisory_unlock(${USER_REFRESH_LOCK_KEY_1}, ${USER_REFRESH_LOCK_KEY_2})`,
			);
		},

		async usersForMetric(metric, limit) {
			return usersForMetric(database, metric as UserRefreshMetric, limit);
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
			const totals = await aggregateMonthlyTotals(database, id);
			// `last_fetched` is the contribution-month freshness marker for this worker. It does
			// not mean profile metadata was refreshed; profile columns stay on-demand/manual.
			await database
				.update(entities)
				.set({
					totalCommits: totals.commits,
					totalRestricted: totals.restricted,
					totalIssues: totals.issues,
					totalPullRequests: totals.pullRequests,
					totalReviews: totals.reviews,
					totalRepos: totals.repos,
					lastFetched: fetchedAt,
				})
				.where(eq(entities.id, id));
			return totals;
		},
	};
}

async function usersForMetric(
	database: DB,
	metric: UserRefreshMetric,
	limit: number,
): Promise<RefreshCandidate[]> {
	const active = and(
		isNull(entities.suspendedAt),
		eq(entities.kind, "user"),
		isNotNull(entities.builtAt),
	);
	const rankCol = metric === "total" ? entities.totalCommits : RANK_COL[metric];
	const order =
		metric === "total"
			? desc(totalExpr())
			: sql`${rankCol} desc nulls last`;
	const positive = {
		prs: entities.totalPullRequests,
		issues: entities.totalIssues,
		reviews: entities.totalReviews,
		repos: entities.totalRepos,
		private: entities.totalRestricted,
		followers: entities.followers,
	}[metric as "prs" | "issues" | "reviews" | "repos" | "private" | "followers"];

	const where = positive ? and(active, gt(positive, 0)) : active;
	return database
		.select({ id: entities.id, login: entities.login })
		.from(entities)
		.where(where)
		.orderBy(order, asc(entities.id))
		.limit(limit);
}

function totalExpr() {
	return sql<number>`${entities.totalCommits} + coalesce(${entities.totalIssues}, 0) + coalesce(${entities.totalPullRequests}, 0) + coalesce(${entities.totalReviews}, 0) + coalesce(${entities.totalRepos}, 0) + ${entities.totalRestricted}`;
}

async function aggregateMonthlyTotals(
	database: DB,
	id: string,
): Promise<MonthlyCount> {
	const [row] = await database
		.select({
			commits: sql<number>`coalesce(sum(${monthlyCommits.commits}), 0)`,
			restricted: sql<number>`coalesce(sum(${monthlyCommits.restricted}), 0)`,
			issues: sql<number>`coalesce(sum(${monthlyCommits.issues}), 0)`,
			pullRequests: sql<number>`coalesce(sum(${monthlyCommits.pullRequests}), 0)`,
			reviews: sql<number>`coalesce(sum(${monthlyCommits.reviews}), 0)`,
			repos: sql<number>`coalesce(sum(${monthlyCommits.repos}), 0)`,
		})
		.from(monthlyCommits)
		.where(eq(monthlyCommits.entityId, id));

	return {
		commits: Number(row?.commits ?? 0),
		restricted: Number(row?.restricted ?? 0),
		issues: Number(row?.issues ?? 0),
		pullRequests: Number(row?.pullRequests ?? 0),
		reviews: Number(row?.reviews ?? 0),
		repos: Number(row?.repos ?? 0),
	};
}
