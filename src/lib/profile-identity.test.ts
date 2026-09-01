import { describe, expect, it } from "vitest";
import type { Profile } from "#/lib/github";
import {
	type ProfileIdentityCandidate,
	ProfileIdentityConflictError,
	resolveProfileIdentity,
} from "#/lib/profile-identity";

const profile = (nodeId: string, login: string): Profile => ({
	nodeId,
	login,
	name: login,
	avatarUrl: `https://avatars.example/${login}`,
	createdAt: "2020-01-01T00:00:00.000Z",
	bio: null,
	company: null,
	location: null,
	websiteUrl: null,
	twitterUsername: null,
	followers: 1,
	following: 2,
	publicRepos: 3,
});

const candidate = (
	id: string,
	login: string,
	githubNodeId: string | null,
): ProfileIdentityCandidate => ({ id, login, githubNodeId });

describe("profile identity resolution", () => {
	it("keeps a renamed profile on the row identified by its immutable node id", () => {
		const result = resolveProfileIdentity(profile("U_immutable", "new-login"), {
			byNodeId: candidate("user:old-login", "old-login", "U_immutable"),
			byCurrentLogin: [],
		});

		expect(result).toEqual({
			entityId: "user:old-login",
			operation: "update",
		});
	});

	it("gives a recycled login a new row instead of the previous owner's row", () => {
		const result = resolveProfileIdentity(
			profile("U_new_owner", "shared-login"),
			{
				byNodeId: null,
				byCurrentLogin: [
					candidate("user:shared-login", "shared-login", "U_old_owner"),
				],
			},
		);

		expect(result).toEqual({
			entityId: "github-user:U_new_owner",
			operation: "insert",
		});
	});

	it("claims one legacy login row when it has no immutable identity yet", () => {
		const result = resolveProfileIdentity(profile("U_claimed", "legacy"), {
			byNodeId: null,
			byCurrentLogin: [candidate("user:legacy", "Legacy", null)],
		});

		expect(result).toEqual({
			entityId: "user:legacy",
			operation: "update",
		});
	});

	it("fails closed when multiple legacy rows could own the current login", () => {
		expect(() =>
			resolveProfileIdentity(profile("U_unknown", "ambiguous"), {
				byNodeId: null,
				byCurrentLogin: [
					candidate("user:ambiguous", "ambiguous", null),
					candidate("user:legacy-alias", "Ambiguous", null),
				],
			}),
		).toThrow(ProfileIdentityConflictError);
	});

	it("fails closed when the immutable node id is already duplicated", () => {
		expect(() =>
			resolveProfileIdentity(profile("U_duplicate", "current"), {
				byNodeId: [
					candidate("user:first", "first", "U_duplicate"),
					candidate("user:second", "second", "U_duplicate"),
				],
				byCurrentLogin: [],
			}),
		).toThrow(ProfileIdentityConflictError);
	});
});
