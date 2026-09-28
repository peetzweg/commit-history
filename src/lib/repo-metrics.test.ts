import { describe, expect, it } from "vitest";
import type { ContributorStatsRow } from "#/lib/github-repo";
import {
	fetchContributorCounts,
	parseRepoRef,
	repoId,
} from "#/lib/github-repo";
import {
	backfillStart,
	busFactor,
	isStatsTruncated,
	starsByMonth,
	summarizeContributors,
} from "#/lib/repo-metrics";

const NOW = new Date("2026-09-28T00:00:00Z");
const week = (iso: string, c: number) => ({ w: Date.parse(iso) / 1000, c });

describe("parseRepoRef", () => {
	it("accepts owner/name and canonicalises the id", () => {
		const ref = parseRepoRef(" paritytech/polkadot-sdk ");
		expect(ref).toEqual({ owner: "paritytech", name: "polkadot-sdk" });
		expect(repoId({ owner: "TanStack", name: "Router" })).toBe(
			"tanstack/router",
		);
	});

	it("rejects anything that could break out of a query string", () => {
		for (const raw of [
			"paritytech",
			"a/b/c",
			'a/b"',
			"a/b c",
			"a/..",
			"/name",
			"owner/",
			"own er/x",
		]) {
			expect(parseRepoRef(raw)).toBeNull();
		}
	});
});

describe("summarizeContributors", () => {
	const rows: ContributorStatsRow[] = [
		{
			author: { login: "alice" },
			total: 60,
			weeks: [week("2024-01-07", 50), week("2026-08-02", 10)],
		},
		{
			author: { login: "bob" },
			total: 30,
			weeks: [week("2025-02-02", 30), week("2026-08-09", 0)],
		},
		{ author: null, total: 10, weeks: [week("2026-08-30", 10)] },
	];

	it("counts only contributors with a commit in the trailing 52 weeks as active", () => {
		// bob's only in-window week has zero commits.
		expect(summarizeContributors(rows, NOW).activeContributorsLastYear).toBe(2);
	});

	it("buckets activity by the month a week starts in and marks first months as new", () => {
		const m = summarizeContributors(rows, NOW).monthly;
		expect(m.get("2024-01-01")).toEqual({ active: 1, new: 1 });
		expect(m.get("2025-02-01")).toEqual({ active: 1, new: 1 });
		// alice's second month plus the anonymous row (week of Aug 30 starts in August).
		expect(m.get("2026-08-01")).toEqual({ active: 2, new: 1 });
		expect(m.has("2026-09-01")).toBe(false);
	});

	it("handles an empty repository", () => {
		const s = summarizeContributors([], NOW);
		expect(s).toMatchObject({ rows: 0, busFactor: 0 });
	});
});

describe("busFactor", () => {
	it("is the fewest contributors covering half of all commits", () => {
		expect(busFactor([60, 30, 10])).toBe(1);
		expect(busFactor([40, 30, 30])).toBe(2);
		expect(busFactor([1, 1, 1, 1])).toBe(2);
		expect(busFactor([0, 0])).toBe(0);
	});
});

describe("starsByMonth", () => {
	it("counts timestamps per UTC month", () => {
		const m = starsByMonth([
			"2026-07-31T23:59:59Z",
			"2026-08-01T00:00:00Z",
			"2026-08-15T12:00:00Z",
		]);
		expect(Object.fromEntries(m)).toEqual({ "2026-07-01": 1, "2026-08-01": 2 });
	});
});

describe("backfillStart", () => {
	it("reaches back to history that predates the repository", () => {
		const created = new Date("2023-08-04T00:00:00Z");
		const rows: ContributorStatsRow[] = [
			{
				author: null,
				total: 1,
				weeks: [week("2017-11-05", 0), week("2017-11-12", 3)],
			},
		];
		expect(backfillStart(created, rows).toISOString()).toBe(
			"2017-11-12T00:00:00.000Z",
		);
		expect(backfillStart(created, null)).toEqual(created);
	});
});

describe("fetchContributorCounts", () => {
	const ref = { owner: "paritytech", name: "substrate" };
	const reply = (
		headers: Record<string, string>,
		body: unknown = [{}],
		status = 200,
	) => new Response(JSON.stringify(body), { status, headers });

	it("reads each count off the last-page link instead of paginating", async () => {
		const urls: string[] = [];
		const fetchImpl = (async (url: string) => {
			urls.push(url);
			const n = url.includes("anon=true") ? 483 : 381;
			return reply({
				link: `<https://api.github.com/repositories/1/contributors?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/contributors?per_page=1&page=${n}>; rel="last"`,
			});
		}) as typeof fetch;
		expect(await fetchContributorCounts(ref, "t", fetchImpl)).toEqual({
			total: 483,
			linked: 381,
		});
		expect(urls).toHaveLength(2);
	});

	it("falls back to the body when everything fits on one page", async () => {
		const fetchImpl = (async () => reply({}, [{}])) as unknown as typeof fetch;
		expect(await fetchContributorCounts(ref, "t", fetchImpl)).toEqual({
			total: 1,
			linked: 1,
		});
	});

	it("returns null when GitHub refuses to list a too-large history", async () => {
		const fetchImpl = (async () =>
			reply(
				{ "x-ratelimit-remaining": "4000" },
				{},
				403,
			)) as unknown as typeof fetch;
		expect(await fetchContributorCounts(ref, "t", fetchImpl)).toBeNull();
	});
});

describe("isStatsTruncated", () => {
	it("treats statistics with fewer rows than listed contributors as lower bounds", () => {
		expect(isStatsTruncated(100, 483)).toBe(true); // substrate
		// rust-lang/rust: 499 rows, 8,839 listed; the linked count (442) is itself capped.
		expect(isStatsTruncated(499, 8839)).toBe(true);
		expect(isStatsTruncated(20, 17)).toBe(false); // polkadot-api
		expect(isStatsTruncated(500, null)).toBe(false); // torvalds/linux: list refused
	});
});
