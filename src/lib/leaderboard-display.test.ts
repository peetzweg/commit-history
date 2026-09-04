import { describe, expect, it } from "vitest";
import { leaderboardValue } from "#/lib/leaderboard-display";

const totals = {
	totalCommits: 10,
	totalRestricted: 2,
	totalIssues: 3,
	totalPullRequests: 4,
	totalReviews: 5,
	totalRepos: 6,
	followers: 7,
};

describe("leaderboardValue", () => {
	it("keeps the shared homepage and network metric totals aligned", () => {
		expect(leaderboardValue(totals, "public")).toBe(10);
		expect(leaderboardValue(totals, "prs")).toBe(4);
		expect(leaderboardValue(totals, "issues")).toBe(3);
		expect(leaderboardValue(totals, "reviews")).toBe(5);
		expect(leaderboardValue(totals, "repos")).toBe(6);
		expect(leaderboardValue(totals, "private")).toBe(2);
		expect(leaderboardValue(totals, "followers")).toBe(7);
		expect(leaderboardValue(totals, "total")).toBe(30);
	});
});
