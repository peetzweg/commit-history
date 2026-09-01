import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "#/lib/github";

const mocks = vi.hoisted(() => {
	const profile: Profile = {
		nodeId: "U_new_owner",
		login: "shared-login",
		name: "Current owner",
		avatarUrl: "https://avatars.example/current",
		createdAt: "2026-07-01T00:00:00.000Z",
		bio: null,
		company: null,
		location: null,
		websiteUrl: null,
		twitterUsername: null,
		followers: 1,
		following: 2,
		publicRepos: 3,
	};
	const now = new Date("2026-08-31T08:00:00.000Z");
	const entityRow = (
		id: string,
		nodeId: string,
		lastFetched: Date,
		name: string,
	) => ({
		id,
		kind: "user",
		login: profile.login,
		name,
		avatarUrl: "",
		htmlUrl: `https://github.com/${profile.login}`,
		createdAt: new Date(profile.createdAt),
		totalCommits: 7,
		totalRestricted: 0,
		totalIssues: 0,
		totalPullRequests: 0,
		totalReviews: 0,
		totalRepos: 0,
		followers: 0,
		following: 0,
		publicRepos: 0,
		bio: null,
		company: null,
		location: null,
		websiteUrl: null,
		twitterUsername: null,
		isVerified: null,
		githubNodeId: nodeId,
		memberCount: null,
		lastFetched,
		builtAt: now,
		membersEnumeratedAt: null,
		suspendedAt: null,
		suspendedReason: null,
		unreachableAt: null,
	});
	return {
		profile,
		now,
		entityRow,
		candidateRows: [] as ReturnType<typeof entityRow>[],
		monthRows: [] as Array<Record<string, unknown>>,
		candidateClauses: [] as unknown[],
		monthClauses: [] as unknown[],
		fetchProfile: vi.fn(async () => profile),
		fetchMonthlyCommits: vi.fn(async () => []),
		saveProfileIdentity: vi.fn(),
	};
});

vi.mock("#/lib/db", () => ({
	db: {
		select: () => ({
			from: () => ({
				where: (clause: unknown) => {
					let limited = false;
					return Object.assign(
						Promise.resolve().then(() => {
							if (!limited) mocks.monthClauses.push(clause);
							return mocks.monthRows;
						}),
						{
							limit: async () => {
								limited = true;
								mocks.candidateClauses.push(clause);
								return mocks.candidateRows;
							},
						},
					);
				},
			}),
		}),
	},
}));

vi.mock("#/lib/github", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/github")>()),
	fetchProfile: mocks.fetchProfile,
	fetchMonthlyCommits: mocks.fetchMonthlyCommits,
}));

vi.mock("#/lib/profile-identity", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/profile-identity")>()),
	saveProfileIdentity: mocks.saveProfileIdentity,
}));

import { getCommitHistory } from "#/lib/cache";

const dialect = new PgDialect();
const monthsFor = (entityId: string) => [
	{
		entityId,
		month: "2026-07-01",
		commits: 7,
		restricted: 0,
		issues: 0,
		pullRequests: 0,
		reviews: 0,
		repos: 0,
		fetchedAt: mocks.now,
	},
];

describe("live profile cache identity", () => {
	beforeEach(() => {
		mocks.candidateRows = [];
		mocks.monthRows = [];
		mocks.candidateClauses.length = 0;
		mocks.monthClauses.length = 0;
		vi.clearAllMocks();
	});

	it("serves one fresh login match without a GitHub call", async () => {
		const cachedId = "user:shared-login";
		mocks.candidateRows = [
			mocks.entityRow(cachedId, "U_cached", mocks.now, "Cached owner"),
		];
		mocks.monthRows = monthsFor(cachedId);

		const history = await getCommitHistory(mocks.profile.login, "token", {
			now: mocks.now,
			record: false,
		});

		expect(history.user.nodeId).toBe("U_cached");
		expect(history.total).toBe(7);
		expect(mocks.fetchProfile).not.toHaveBeenCalled();
		expect(mocks.saveProfileIdentity).not.toHaveBeenCalled();
	});

	it("resolves a stale login before reading history from its current owner", async () => {
		const oldId = "user:shared-login";
		const resolvedId = "github-user:U_new_owner";
		mocks.candidateRows = [
			mocks.entityRow(
				oldId,
				"U_old_owner",
				new Date("2026-08-31T07:00:00.000Z"),
				"Previous owner",
			),
		];
		mocks.monthRows = monthsFor(resolvedId);
		mocks.saveProfileIdentity.mockResolvedValue({
			entityId: resolvedId,
			created: false,
			row: mocks.entityRow(
				resolvedId,
				mocks.profile.nodeId,
				mocks.now,
				"Current owner",
			),
		});

		const history = await getCommitHistory(mocks.profile.login, "token", {
			now: mocks.now,
			record: false,
		});

		expect(mocks.saveProfileIdentity).toHaveBeenCalledWith(
			expect.anything(),
			mocks.profile,
		);
		expect(history.user).toBe(mocks.profile);
		expect(history.total).toBe(7);

		const monthQuery = dialect.sqlToQuery(mocks.monthClauses[0] as never);
		expect(monthQuery.params).toEqual([resolvedId]);
		expect(monthQuery.params).not.toContain(oldId);
	});
});
