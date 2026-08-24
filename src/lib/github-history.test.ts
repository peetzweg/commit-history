import { describe, expect, it } from "vitest";
import { cumulativeGithubPoints } from "#/lib/github-history";

describe("cumulativeGithubPoints", () => {
	it("accumulates each monthly metric without mixing public and private commits", () => {
		expect(
			cumulativeGithubPoints([
				{
					date: "2025-01-01",
					commits: 10,
					restricted: 2,
					issues: 3,
					pullRequests: 4,
					reviews: 5,
					repos: 1,
				},
				{
					date: "2025-02-01",
					commits: 7,
					restricted: 6,
					issues: 0,
					pullRequests: 2,
					reviews: 1,
					repos: 0,
				},
			]),
		).toEqual([
			{
				date: "2025-01-01",
				commits: 10,
				cumulative: 10,
				restricted: 2,
				restrictedCumulative: 2,
				issues: 3,
				pullRequests: 4,
				reviews: 5,
				repos: 1,
			},
			{
				date: "2025-02-01",
				commits: 7,
				cumulative: 17,
				restricted: 6,
				restrictedCumulative: 8,
				issues: 0,
				pullRequests: 2,
				reviews: 1,
				repos: 0,
			},
		]);
	});
});
