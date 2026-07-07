import type { ChartMode } from "#/components/CommitChart";
import type { LeaderMode } from "#/lib/commit-history";
import type { CommitHistory } from "#/lib/github";

// Shared metric vocabulary for the floating tab bar and the chart. `LeaderMode` (leaderboard) is the
// superset — it adds "followers"; the chart's `ChartMode` is everything else.

export const METRIC_LABEL: Record<LeaderMode, string> = {
	public: "Commits",
	prs: "PRs",
	issues: "Issues",
	reviews: "Reviews",
	repos: "Repos",
	private: "Private",
	total: "Total",
	followers: "Followers",
};

// The /metrics/<slug> explainer article for each metric (src/content/metrics/) — surfaced
// as a tertiary "What is this?" link next to the leaderboard subtitle and chart captions.
export const METRIC_EXPLAINER: Record<LeaderMode, string> = {
	public: "commits",
	prs: "pull-requests",
	issues: "issues",
	reviews: "reviews",
	repos: "repositories",
	private: "private-contributions",
	total: "total-contributions",
	followers: "followers",
};

export const METRIC_TOTAL: Record<ChartMode, (h: CommitHistory) => number> = {
	public: (h) => h.total,
	prs: (h) => h.totalPullRequests,
	issues: (h) => h.totalIssues,
	reviews: (h) => h.totalReviews,
	repos: (h) => h.totalRepos,
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
 * private only when at least one developer has any; and "total" only when there's something beyond
 * commits to add up (else it would just duplicate the commits line).
 */
export function availableMetrics(histories: CommitHistory[]): ChartMode[] {
	const any = (m: ChartMode) => histories.some((h) => METRIC_TOTAL[m](h) > 0);
	const list: ChartMode[] = ["public"];
	for (const m of ["prs", "issues", "reviews", "repos"] as const)
		if (any(m)) list.push(m);
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
	"public",
	"prs",
	"issues",
	"reviews",
	"repos",
	"private",
	"total",
];
