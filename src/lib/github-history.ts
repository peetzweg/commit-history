import { createServerFn } from "@tanstack/react-start";
import type { CommitPoint } from "#/lib/github";

/** One calendar month's activity across every tracked GitHub user. */
export interface GithubMonth {
	date: string;
	commits: number;
	restricted: number;
	issues: number;
	pullRequests: number;
	reviews: number;
	repos: number;
}

export interface GithubHistory {
	/** Cumulative monthly activity across every tracked user with stored monthly data. */
	points: CommitPoint[];
	/** Users represented in at least one of the source months. */
	trackedUsers: number;
}

/**
 * The site-wide history scans every stored monthly contribution row. Keep it available while
 * developing the replacement aggregate locally, but do not let it hold up production navigation.
 */
export function isGithubHistoryEnabled(
	env: Pick<NodeJS.ProcessEnv, "NODE_ENV"> = process.env,
): boolean {
	return env.NODE_ENV !== "production";
}

/**
 * Adds cumulative values to aggregate monthly rows. Kept separate from the database query so
 * the public interface is easy to exercise without a database and every chart receives the same
 * `CommitPoint` shape as an individual profile.
 */
export function cumulativeGithubPoints(months: GithubMonth[]): CommitPoint[] {
	let cumulative = 0;
	let restrictedCumulative = 0;
	return months.map((month) => {
		cumulative += month.commits;
		restrictedCumulative += month.restricted;
		return {
			date: month.date,
			commits: month.commits,
			cumulative,
			restricted: month.restricted,
			restrictedCumulative,
			issues: month.issues,
			pullRequests: month.pullRequests,
			reviews: month.reviews,
			repos: month.repos,
		};
	});
}

/** Database-backed implementation shared by the page loader and its Open Graph renderer. */
export async function queryGithubHistory(): Promise<GithubHistory> {
	// This module is imported by a route, so database code must stay inside the server handler.
	// A top-level import would make Vite traverse postgres.js from the browser-facing graph.
	const [{ asc, eq, sql }, { db }, { entities, monthlyCommits }] =
		await Promise.all([
			import("drizzle-orm"),
			import("#/lib/db"),
			import("#/lib/db/schema"),
		]);
	if (!db) return { points: [], trackedUsers: 0 };

	// Only user rows belong here. Organization totals are derived from member contributions and
	// including them would count the same work twice. Suspended/unreachable users stay included:
	// this is a historical dataset, not a current leaderboard population.
	const [rows, userCountRows] = await Promise.all([
		db
			.select({
				date: monthlyCommits.month,
				commits: sql<string>`sum(${monthlyCommits.commits})`,
				restricted: sql<string>`sum(${monthlyCommits.restricted})`,
				issues: sql<string>`sum(${monthlyCommits.issues})`,
				pullRequests: sql<string>`sum(${monthlyCommits.pullRequests})`,
				reviews: sql<string>`sum(${monthlyCommits.reviews})`,
				repos: sql<string>`sum(${monthlyCommits.repos})`,
			})
			.from(monthlyCommits)
			.innerJoin(entities, eq(entities.id, monthlyCommits.entityId))
			.where(eq(entities.kind, "user"))
			.groupBy(monthlyCommits.month)
			.orderBy(asc(monthlyCommits.month)),
		db
			.select({
				count: sql<string>`count(distinct ${monthlyCommits.entityId})`,
			})
			.from(monthlyCommits)
			.innerJoin(entities, eq(entities.id, monthlyCommits.entityId))
			.where(eq(entities.kind, "user")),
	]);

	const months: GithubMonth[] = rows.map((row) => ({
		date: row.date,
		commits: Number(row.commits),
		restricted: Number(row.restricted),
		issues: Number(row.issues),
		pullRequests: Number(row.pullRequests),
		reviews: Number(row.reviews),
		repos: Number(row.repos),
	}));
	return {
		points: cumulativeGithubPoints(months),
		trackedUsers: Number(userCountRows[0]?.count ?? 0),
	};
}

/** Aggregate time series for the public GitHub activity page. */
export const getGithubHistory = createServerFn({ method: "GET" }).handler(
	async (): Promise<GithubHistory & { enabled: boolean }> => {
		if (!isGithubHistoryEnabled()) {
			return { points: [], trackedUsers: 0, enabled: false };
		}
		return { ...(await queryGithubHistory()), enabled: true };
	},
);
