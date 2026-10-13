import { desc, eq, inArray, sql } from "drizzle-orm";
import type {
	CurrentMonthStore,
	MonthToDateSnapshot,
} from "#/lib/current-month";
import type { DB } from "#/lib/db";
import { monthToDateSnapshots } from "#/lib/db/schema";
import { createJobLock, LOCK_KEYS } from "#/lib/job-runner";
import { usersForMetric } from "#/lib/monthly-user-refresh-store";

export function createCurrentMonthStore(database: DB): CurrentMonthStore {
	const lock = createJobLock(
		...LOCK_KEYS.currentMonthRefresh,
		"current-month-refresh",
	);

	return {
		tryLock: lock.tryLock,
		releaseLock: lock.releaseLock,

		usersForMetric: (metric, limit) => usersForMetric(database, metric, limit),

		async latestSnapshot(id) {
			const [row] = await database
				.select({
					month: monthToDateSnapshots.month,
					fetchedAt: monthToDateSnapshots.fetchedAt,
				})
				.from(monthToDateSnapshots)
				.where(eq(monthToDateSnapshots.entityId, id))
				.orderBy(desc(monthToDateSnapshots.fetchedAt))
				.limit(1);
			return row ?? null;
		},

		async upsertSnapshot(id, month, counts, fetchedAt) {
			const day = fetchedAt.toISOString().slice(0, 10);
			await database
				.insert(monthToDateSnapshots)
				.values({ entityId: id, day, month, ...counts, fetchedAt })
				.onConflictDoUpdate({
					target: [monthToDateSnapshots.entityId, monthToDateSnapshots.day],
					set: {
						month: sql`excluded.month`,
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
	};
}

/** Newest snapshot per entity id, for the lookup path. One round-trip for a whole comparison. */
export async function latestSnapshots(
	database: DB,
	ids: string[],
): Promise<Map<string, MonthToDateSnapshot>> {
	const out = new Map<string, MonthToDateSnapshot>();
	if (ids.length === 0) return out;
	const rows = await database
		.selectDistinctOn([monthToDateSnapshots.entityId])
		.from(monthToDateSnapshots)
		.where(inArray(monthToDateSnapshots.entityId, ids))
		.orderBy(
			monthToDateSnapshots.entityId,
			desc(monthToDateSnapshots.fetchedAt),
		);
	for (const r of rows) {
		out.set(r.entityId, {
			month: r.month,
			fetchedAt: r.fetchedAt,
			counts: {
				commits: r.commits,
				restricted: r.restricted,
				issues: r.issues,
				pullRequests: r.pullRequests,
				reviews: r.reviews,
				repos: r.repos,
			},
		});
	}
	return out;
}
