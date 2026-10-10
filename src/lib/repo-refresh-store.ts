import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import {
	repositories,
	repositoryMonthly,
	repositorySnapshots,
} from "#/lib/db/schema";
import { repoId } from "#/lib/github-repo";
import { createJobLock, LOCK_KEYS } from "#/lib/job-runner";
import type { DueRepo, RepoRefreshStore } from "#/lib/repo-refresh";

/** End of the month labelled `YYYY-MM-01`, as the first instant of the next month (UTC). */
function monthEnd(label: string): Date {
	const [y, m] = label.split("-").map(Number);
	return new Date(Date.UTC(y, m, 1));
}

export function createRepoRefreshStore(database: DB): RepoRefreshStore {
	const lock = createJobLock(
		database,
		...LOCK_KEYS.repoRefresh,
		"repo-refresh",
	);
	const dueColumns = {
		id: repositories.id,
		owner: repositories.owner,
		name: repositories.name,
		starsBackfilledAt: repositories.starsBackfilledAt,
	};

	return {
		tryLock: lock.tryLock,
		releaseLock: lock.releaseLock,

		async track(refs) {
			if (!refs.length) return;
			await database
				.insert(repositories)
				.values(
					refs.map((r) => ({ id: repoId(r), owner: r.owner, name: r.name })),
				)
				.onConflictDoNothing();
		},

		async dueRepos(staleBefore, limit): Promise<DueRepo[]> {
			return (
				database
					.select(dueColumns)
					.from(repositories)
					.where(
						and(
							isNull(repositories.unreachableAt),
							or(
								isNull(repositories.metricsFetchedAt),
								lt(repositories.metricsFetchedAt, staleBefore),
								isNull(repositories.statsFetchedAt),
							),
						),
					)
					// Never measured first, then oldest snapshot.
					.orderBy(
						sql`${repositories.metricsFetchedAt} asc nulls first`,
						asc(repositories.id),
					)
					.limit(limit)
			);
		},

		async namedRepos(ids) {
			if (!ids.length) return [];
			return database
				.select(dueColumns)
				.from(repositories)
				.where(inArray(repositories.id, ids));
		},

		async saveSnapshot(id, s, contributors, now) {
			await database
				.update(repositories)
				.set({
					githubNodeId: s.nodeId,
					// Follow renames/transfers for display; the id stays what it was tracked as.
					owner: s.owner,
					name: s.name,
					description: s.description,
					ownerAvatarUrl: s.ownerAvatarUrl,
					primaryLanguage: s.primaryLanguage,
					license: s.license,
					createdAt: new Date(s.createdAt),
					pushedAt: s.pushedAt ? new Date(s.pushedAt) : null,
					isArchived: s.isArchived,
					isFork: s.isFork,
					defaultBranch: s.defaultBranch,
					defaultBranchTipSha: s.defaultBranchTipSha,
					stars: s.stars,
					forks: s.forks,
					watchers: s.watchers,
					commits: s.commits,
					commitsLastYear: s.commitsLastYear,
					openIssues: s.openIssues,
					closedIssues: s.closedIssues,
					openPullRequests: s.openPullRequests,
					mergedPullRequests: s.mergedPullRequests,
					closedPullRequests: s.closedPullRequests,
					releases: s.releases,
					// Keep the last known count when GitHub declines to list contributors this time.
					...(contributors && {
						contributors: contributors.total,
						anonymousContributors: contributors.total - contributors.linked,
					}),
					metricsFetchedAt: now,
					unreachableAt: null,
				})
				.where(eq(repositories.id, id));

			const values = {
				stars: s.stars,
				forks: s.forks,
				watchers: s.watchers,
				commits: s.commits,
				openIssues: s.openIssues,
				openPullRequests: s.openPullRequests,
				mergedPullRequests: s.mergedPullRequests,
				releases: s.releases,
				contributors: contributors?.total ?? null,
				measuredAt: now,
			};
			await database
				.insert(repositorySnapshots)
				.values({ repoId: id, day: now.toISOString().slice(0, 10), ...values })
				.onConflictDoUpdate({
					target: [repositorySnapshots.repoId, repositorySnapshots.day],
					set: values,
				});
		},

		async saveContributorStats(id, stats, tipSha, now) {
			await database
				.update(repositories)
				.set({
					contributorStatsRows: stats.rows,
					activeContributorsLastYear: stats.activeContributorsLastYear,
					busFactor: stats.busFactor,
					statsFetchedAt: now,
					statsTipSha: tipSha,
				})
				.where(eq(repositories.id, id));
			// Months back-filled while stats were still pending get their contributor columns now.
			await database
				.update(repositoryMonthly)
				.set({ activeContributors: 0, newContributors: 0 })
				.where(eq(repositoryMonthly.repoId, id));
			for (const [month, b] of stats.monthly) {
				await database
					.update(repositoryMonthly)
					.set({ activeContributors: b.active, newContributors: b.new })
					.where(
						and(
							eq(repositoryMonthly.repoId, id),
							eq(repositoryMonthly.month, month),
						),
					);
			}
		},

		async finalMonths(id) {
			const rows = await database
				.select({
					month: repositoryMonthly.month,
					fetchedAt: repositoryMonthly.fetchedAt,
				})
				.from(repositoryMonthly)
				.where(eq(repositoryMonthly.repoId, id));
			return new Set(
				rows
					.filter((r) => r.fetchedAt >= monthEnd(r.month))
					.map((r) => r.month),
			);
		},

		async saveMonthlyFlows(id, flows, stats, now) {
			if (!flows.length) return;
			await database
				.insert(repositoryMonthly)
				.values(
					flows.map((f) => {
						const b = stats?.monthly.get(f.month);
						return {
							repoId: id,
							...f,
							activeContributors: stats ? (b?.active ?? 0) : null,
							newContributors: stats ? (b?.new ?? 0) : null,
							fetchedAt: now,
						};
					}),
				)
				.onConflictDoUpdate({
					target: [repositoryMonthly.repoId, repositoryMonthly.month],
					set: {
						commits: sql`excluded.commits`,
						issuesOpened: sql`excluded.issues_opened`,
						issuesClosed: sql`excluded.issues_closed`,
						pullRequestsOpened: sql`excluded.pull_requests_opened`,
						pullRequestsMerged: sql`excluded.pull_requests_merged`,
						activeContributors: sql`coalesce(excluded.active_contributors, ${repositoryMonthly.activeContributors})`,
						newContributors: sql`coalesce(excluded.new_contributors, ${repositoryMonthly.newContributors})`,
						fetchedAt: sql`excluded.fetched_at`,
					},
				});
		},

		async saveStars(id, byMonth, now) {
			await database
				.update(repositoryMonthly)
				.set({ starsGained: 0 })
				.where(eq(repositoryMonthly.repoId, id));
			for (const [month, stars] of byMonth) {
				await database
					.update(repositoryMonthly)
					.set({ starsGained: stars })
					.where(
						and(
							eq(repositoryMonthly.repoId, id),
							eq(repositoryMonthly.month, month),
						),
					);
			}
			await database
				.update(repositories)
				.set({ starsBackfilledAt: now })
				.where(eq(repositories.id, id));
		},

		async markUnreachable(id, now) {
			await database
				.update(repositories)
				.set({ unreachableAt: now })
				.where(
					and(eq(repositories.id, id), isNull(repositories.unreachableAt)),
				);
		},
	};
}
