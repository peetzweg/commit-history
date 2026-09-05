import type { LeaderMetric } from "#/lib/leaderboard-rank";

export interface LeaderboardTotals {
	totalCommits: number;
	totalRestricted: number;
	totalIssues: number | null;
	totalPullRequests: number | null;
	totalReviews: number | null;
	totalRepos: number | null;
	followers: number | null;
}

export const LEADERBOARD_HEADING: Record<LeaderMetric, string> = {
	public: "Commit",
	prs: "PR",
	issues: "Issue",
	reviews: "Review",
	repos: "Repo",
	private: "Private",
	total: "Total",
	followers: "Follower",
};

export const LEADERBOARD_UNIT: Record<LeaderMetric, string> = {
	public: "commits",
	prs: "pull requests",
	issues: "issues",
	reviews: "reviews",
	repos: "repos",
	private: "private",
	total: "contributions",
	followers: "followers",
};

export const LEADERBOARD_SUBTITLE: Record<LeaderMetric, string> = {
	public: "Public commits.",
	prs: "Public pull requests opened.",
	issues: "Public issues opened.",
	reviews: "Public pull-request reviews.",
	repos: "Public repositories created — forks don’t count.",
	private: "Private contributions (only users who expose them).",
	total:
		"Every contribution type — commits, PRs, issues, reviews, repos, plus private.",
	followers: "GitHub followers.",
};

export function leaderboardValue(
	entry: LeaderboardTotals,
	metric: LeaderMetric,
): number {
	switch (metric) {
		case "public":
			return entry.totalCommits;
		case "prs":
			return entry.totalPullRequests ?? 0;
		case "issues":
			return entry.totalIssues ?? 0;
		case "reviews":
			return entry.totalReviews ?? 0;
		case "repos":
			return entry.totalRepos ?? 0;
		case "private":
			return entry.totalRestricted;
		case "total":
			return (
				entry.totalCommits +
				(entry.totalIssues ?? 0) +
				(entry.totalPullRequests ?? 0) +
				(entry.totalReviews ?? 0) +
				(entry.totalRepos ?? 0) +
				entry.totalRestricted
			);
		case "followers":
			return entry.followers ?? 0;
	}
}
