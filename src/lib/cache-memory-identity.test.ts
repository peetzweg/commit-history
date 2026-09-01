import { describe, expect, it, vi } from "vitest";
import type { CommitHistory, Profile } from "#/lib/github";

const mocks = vi.hoisted(() => {
	const makeProfile = (nodeId: string): Profile => ({
		nodeId,
		login: "recycled-memory-login",
		name: nodeId,
		avatarUrl: "",
		createdAt: "2026-07-01T00:00:00.000Z",
		bio: null,
		company: null,
		location: null,
		websiteUrl: null,
		twitterUsername: null,
		followers: 0,
		following: 0,
		publicRepos: 0,
	});
	const history = (user: Profile): CommitHistory => ({
		user,
		points: [],
		total: 0,
		totalRestricted: 0,
		totalIssues: 0,
		totalPullRequests: 0,
		totalReviews: 0,
		totalRepos: 0,
	});
	const oldProfile = makeProfile("U_old_owner");
	const newProfile = makeProfile("U_new_owner");
	return {
		oldProfile,
		newProfile,
		fetchProfile: vi.fn(async () => newProfile),
		fetchCommitHistory: vi
			.fn()
			.mockResolvedValueOnce(history(oldProfile))
			.mockResolvedValueOnce(history(newProfile)),
	};
});

vi.mock("#/lib/db", () => ({ db: null }));
vi.mock("#/lib/github", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/github")>()),
	fetchProfile: mocks.fetchProfile,
	fetchCommitHistory: mocks.fetchCommitHistory,
}));

import { getCommitHistory } from "#/lib/cache";

describe("in-memory profile cache identity", () => {
	it("trusts a warm entry, then replaces it when stale ownership changes", async () => {
		const first = await getCommitHistory("recycled-memory-login", "token", {
			now: new Date("2026-08-31T08:00:00.000Z"),
		});
		const warm = await getCommitHistory("recycled-memory-login", "token", {
			now: new Date("2026-08-31T08:00:01.000Z"),
		});
		const stale = await getCommitHistory("recycled-memory-login", "token", {
			now: new Date("2026-08-31T08:01:01.000Z"),
		});

		expect(first.user.nodeId).toBe("U_old_owner");
		expect(warm.user.nodeId).toBe("U_old_owner");
		expect(stale.user.nodeId).toBe("U_new_owner");
		expect(mocks.fetchProfile).toHaveBeenCalledTimes(1);
		expect(mocks.fetchCommitHistory).toHaveBeenCalledTimes(2);
	});
});
