import type { ChartMode } from "#/components/CommitChart";
import type { LeaderMode } from "#/lib/commit-history";
import type { CommitHistory } from "#/lib/github";

// Shared metric vocabulary for the floating tab bar and the chart. `LeaderMode` (leaderboard) is the
// superset — it adds "followers"; the chart's `ChartMode` is everything else.

export const METRIC_LABEL: Record<LeaderMode, string> = {
	commits: "Commits",
	prs: "PRs",
	issues: "Issues",
	reviews: "Reviews",
	repos: "Repos",
	public: "Public",
	private: "Private",
	total: "Total",
	followers: "Followers",
};

export const METRIC_TOTAL: Record<ChartMode, (h: CommitHistory) => number> = {
	commits: (h) => h.total,
	prs: (h) => h.totalPullRequests,
	issues: (h) => h.totalIssues,
	reviews: (h) => h.totalReviews,
	repos: (h) => h.totalRepos,
	public: (h) =>
		h.total +
		h.totalIssues +
		h.totalPullRequests +
		h.totalReviews +
		h.totalRepos,
	private: (h) => h.totalRestricted,
	// Every contribution type summed (disjoint buckets — no double-counting).
	total: (h) =>
		h.total +
		h.totalIssues +
		h.totalPullRequests +
		h.totalReviews +
		h.totalRepos +
		h.totalRestricted,
};

/**
 * Which metrics are worth offering for these histories: commits always; each public type and
 * private only when at least one developer has any; "public" (sum of all public types) only when
 * there's something beyond commits to add up; and "total" only when there's something beyond
 * public contributions to add up (else it would just duplicate the public line).
 */
export function availableMetrics(histories: CommitHistory[]): ChartMode[] {
	const any = (m: ChartMode) => histories.some((h) => METRIC_TOTAL[m](h) > 0);
	const list: ChartMode[] = ["commits"];
	for (const m of ["prs", "issues", "reviews", "repos"] as const)
		if (any(m)) list.push(m);
	if (["prs", "issues", "reviews", "repos"].some((m) => any(m as ChartMode)))
		list.push("public");
	if (any("private")) list.push("private");
	if (
		["prs", "issues", "reviews", "repos", "private"].some((m) =>
			any(m as ChartMode),
		)
	)
		list.push("total");
	return list;
}

// Full metric set shown by the floating bar while a not-yet-cached profile loads (we don't know the
// real availability until the data arrives, so we show everything and it narrows on load).
export const ALL_METRICS: ChartMode[] = [
	"commits",
	"prs",
	"issues",
	"reviews",
	"repos",
	"public",
	"private",
	"total",
];
