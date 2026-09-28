import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/lib/db";
import {
	repositories,
	repositoryMonthly,
	repositorySnapshots,
} from "#/lib/db/schema";

/**
 * Read side of the repository leaderboard (#212). Prototype: rows only exist where
 * scripts/refresh-repos.ts has been run (the development database today); without a DB every
 * function returns an empty result rather than failing.
 */

export const REPO_METRICS = [
	"stars",
	"forks",
	"commits",
	"commitsLastYear",
	"contributors",
	"activeContributorsLastYear",
	"mergedPullRequests",
	"prsMergedLastYear",
	"starsLastYear",
] as const;
export type RepoMetric = (typeof REPO_METRICS)[number];

/** Tab label in the shared metric bar. */
export const REPO_METRIC_LABEL: Record<RepoMetric, string> = {
	stars: "Stars",
	forks: "Forks",
	commits: "Commits",
	commitsLastYear: "Commits 12 mo",
	contributors: "Contributors",
	activeContributorsLastYear: "Active 12 mo",
	mergedPullRequests: "Merged PRs",
	prsMergedLastYear: "PRs 12 mo",
	starsLastYear: "New stars",
};

/** The word called out in the board heading ("<Stars> repository leaderboard"). */
export const REPO_METRIC_HEADING: Record<RepoMetric, string> = {
	stars: "Stars",
	forks: "Forks",
	commits: "Commits",
	commitsLastYear: "Commits",
	contributors: "Contributors",
	activeContributorsLastYear: "Active contributors",
	mergedPullRequests: "Merged PRs",
	prsMergedLastYear: "Merged PRs",
	starsLastYear: "New stars",
};

/** Unit under the value in a row, and the one-line definition under the heading. */
export const REPO_METRIC_UNIT: Record<RepoMetric, string> = {
	stars: "stars",
	forks: "forks",
	commits: "commits",
	commitsLastYear: "commits",
	contributors: "contributors",
	activeContributorsLastYear: "active",
	mergedPullRequests: "merged PRs",
	prsMergedLastYear: "merged PRs",
	starsLastYear: "new stars",
};

export const REPO_METRIC_SUBTITLE: Record<RepoMetric, string> = {
	stars: "Current stargazers.",
	forks: "Current forks.",
	commits: "Commits reachable from the default branch, merges included.",
	commitsLastYear: "Default-branch commits in the last 12 months.",
	contributors:
		"Distinct commit authors GitHub lists, unlinked emails included.",
	activeContributorsLastYear:
		"Contributors with a commit in the last 52 weeks. ≥ marks a lower bound: GitHub's statistics often cover only the top contributors.",
	mergedPullRequests: "Pull requests merged, all time.",
	prsMergedLastYear: "Pull requests merged in the last 12 completed months.",
	starsLastYear:
		"Stars gained in the last 12 completed months. Very large repositories skip star history.",
};

export const REPO_DEFAULT_METRIC: RepoMetric = "stars";

export function isRepoMetric(v: unknown): v is RepoMetric {
	return (
		typeof v === "string" && (REPO_METRICS as readonly string[]).includes(v)
	);
}

export interface RepoLeaderEntry {
	id: string;
	owner: string;
	name: string;
	description: string | null;
	ownerAvatarUrl: string | null;
	primaryLanguage: string | null;
	isArchived: boolean | null;
	defaultBranch: string | null;
	stars: number | null;
	forks: number | null;
	commits: number | null;
	commitsLastYear: number | null;
	contributors: number | null;
	activeContributorsLastYear: number | null;
	mergedPullRequests: number | null;
	openIssues: number | null;
	openPullRequests: number | null;
	/** Sum of the last 12 closed months; null when the repo has no monthly back-fill yet. */
	prsMergedLastYear: number | null;
	/** Null when stars were never back-filled (over the job's star cap). */
	starsLastYear: number | null;
	metricsFetchedAt: string | null;
	statsFetchedAt: string | null;
	/** Rows GitHub's contributor statistics returned; ≥100 means truncated to the top 100. */
	contributorStatsRows: number | null;
	anonymousContributors: number | null;
}

// Trailing-year flows from the monthly table — the last 12 *closed* months.
const lastYear = (column: string) => sql<number | null>`(
	select sum(${sql.raw(column)})::int from ${repositoryMonthly}
	where ${repositoryMonthly.repoId} = ${repositories.id}
	and ${repositoryMonthly.month} >= date_trunc('month', now()) - interval '12 months'
)`;

async function queryRepoLeaderboard(
	metric: RepoMetric,
): Promise<RepoLeaderEntry[]> {
	if (!db) return [];
	const prsMergedLastYear = lastYear("pull_requests_merged");
	const starsLastYear = sql<
		number | null
	>`case when ${repositories.starsBackfilledAt} is null then null else ${lastYear("stars_gained")} end`;
	const derived = { prsMergedLastYear, starsLastYear } as const;
	const order =
		metric === "prsMergedLastYear" || metric === "starsLastYear"
			? derived[metric]
			: repositories[metric];
	const rows = await db
		.select({
			id: repositories.id,
			owner: repositories.owner,
			name: repositories.name,
			description: repositories.description,
			ownerAvatarUrl: repositories.ownerAvatarUrl,
			primaryLanguage: repositories.primaryLanguage,
			isArchived: repositories.isArchived,
			defaultBranch: repositories.defaultBranch,
			stars: repositories.stars,
			forks: repositories.forks,
			commits: repositories.commits,
			commitsLastYear: repositories.commitsLastYear,
			contributors: repositories.contributors,
			activeContributorsLastYear: repositories.activeContributorsLastYear,
			mergedPullRequests: repositories.mergedPullRequests,
			openIssues: repositories.openIssues,
			openPullRequests: repositories.openPullRequests,
			prsMergedLastYear,
			starsLastYear,
			metricsFetchedAt: repositories.metricsFetchedAt,
			statsFetchedAt: repositories.statsFetchedAt,
			contributorStatsRows: repositories.contributorStatsRows,
			anonymousContributors: repositories.anonymousContributors,
		})
		.from(repositories)
		.where(
			and(
				isNull(repositories.unreachableAt),
				sql`${repositories.metricsFetchedAt} is not null`,
			),
		)
		.orderBy(sql`${order} desc nulls last`, asc(repositories.id))
		.limit(100);
	return rows.map((r) => ({
		...r,
		metricsFetchedAt: r.metricsFetchedAt?.toISOString() ?? null,
		statsFetchedAt: r.statsFetchedAt?.toISOString() ?? null,
	}));
}

export const getRepoLeaderboard = createServerFn({ method: "GET" })
	.validator((p: { metric: unknown }) => ({
		metric: isRepoMetric(p?.metric) ? p.metric : REPO_DEFAULT_METRIC,
	}))
	.handler(({ data }) => queryRepoLeaderboard(data.metric));

export interface RepoMonthRow {
	month: string;
	commits: number;
	issuesOpened: number;
	issuesClosed: number;
	pullRequestsOpened: number;
	pullRequestsMerged: number;
	activeContributors: number | null;
	newContributors: number | null;
	starsGained: number | null;
}

export interface RepoDetail {
	repo: RepoLeaderEntry & {
		license: string | null;
		createdAt: string | null;
		pushedAt: string | null;
		defaultBranchTipSha: string | null;
		watchers: number | null;
		closedIssues: number | null;
		closedPullRequests: number | null;
		releases: number | null;
		busFactor: number | null;
		statsTipSha: string | null;
		starsBackfilledAt: string | null;
		unreachableAt: string | null;
	};
	monthly: RepoMonthRow[];
	snapshots: Array<{
		day: string;
		stars: number;
		forks: number;
		openIssues: number;
	}>;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

async function queryRepo(id: string): Promise<RepoDetail | null> {
	if (!db) return null;
	const [r] = await db
		.select()
		.from(repositories)
		.where(eq(repositories.id, id))
		.limit(1);
	if (!r) return null;
	const monthly = await db
		.select({
			month: repositoryMonthly.month,
			commits: repositoryMonthly.commits,
			issuesOpened: repositoryMonthly.issuesOpened,
			issuesClosed: repositoryMonthly.issuesClosed,
			pullRequestsOpened: repositoryMonthly.pullRequestsOpened,
			pullRequestsMerged: repositoryMonthly.pullRequestsMerged,
			activeContributors: repositoryMonthly.activeContributors,
			newContributors: repositoryMonthly.newContributors,
			starsGained: repositoryMonthly.starsGained,
		})
		.from(repositoryMonthly)
		.where(eq(repositoryMonthly.repoId, id))
		.orderBy(asc(repositoryMonthly.month));
	const snapshots = await db
		.select({
			day: repositorySnapshots.day,
			stars: repositorySnapshots.stars,
			forks: repositorySnapshots.forks,
			openIssues: repositorySnapshots.openIssues,
		})
		.from(repositorySnapshots)
		.where(eq(repositorySnapshots.repoId, id))
		.orderBy(desc(repositorySnapshots.day))
		.limit(90);
	const sum = (pick: (m: RepoMonthRow) => number | null) => {
		const recent = monthly.slice(-12);
		if (!recent.length) return null;
		return recent.reduce((s, m) => s + (pick(m) ?? 0), 0);
	};
	return {
		repo: {
			id: r.id,
			owner: r.owner,
			name: r.name,
			description: r.description,
			ownerAvatarUrl: r.ownerAvatarUrl,
			primaryLanguage: r.primaryLanguage,
			isArchived: r.isArchived,
			defaultBranch: r.defaultBranch,
			stars: r.stars,
			forks: r.forks,
			commits: r.commits,
			commitsLastYear: r.commitsLastYear,
			contributors: r.contributors,
			activeContributorsLastYear: r.activeContributorsLastYear,
			mergedPullRequests: r.mergedPullRequests,
			openIssues: r.openIssues,
			openPullRequests: r.openPullRequests,
			prsMergedLastYear: sum((m) => m.pullRequestsMerged),
			starsLastYear: r.starsBackfilledAt ? sum((m) => m.starsGained) : null,
			metricsFetchedAt: iso(r.metricsFetchedAt),
			statsFetchedAt: iso(r.statsFetchedAt),
			contributorStatsRows: r.contributorStatsRows,
			license: r.license,
			createdAt: iso(r.createdAt),
			pushedAt: iso(r.pushedAt),
			defaultBranchTipSha: r.defaultBranchTipSha,
			watchers: r.watchers,
			closedIssues: r.closedIssues,
			closedPullRequests: r.closedPullRequests,
			releases: r.releases,
			anonymousContributors: r.anonymousContributors,
			busFactor: r.busFactor,
			statsTipSha: r.statsTipSha,
			starsBackfilledAt: iso(r.starsBackfilledAt),
			unreachableAt: iso(r.unreachableAt),
		},
		monthly,
		snapshots: snapshots.reverse(),
	};
}

export const getRepository = createServerFn({ method: "GET" })
	.validator((p: { owner: unknown; name: unknown }) => ({
		id: `${String(p?.owner ?? "")}/${String(p?.name ?? "")}`.toLowerCase(),
	}))
	.handler(({ data }) => queryRepo(data.id));
