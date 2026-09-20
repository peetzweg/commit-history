import { describe, expect, it, vi } from "vitest";
import { createProfileNetworkDiscovery } from "#/lib/profile-network-discovery";
import { isNetworkTooLargeFailure } from "#/lib/profile-network-limits";

const job = {
	version: 1 as const,
	ownerGithubNodeId: "U_owner",
	login: "owner",
};
const member = (index: number) => ({
	githubNodeId: `U_${index}`,
	login: `person-${index}`,
	avatarUrl: null,
	htmlUrl: null,
	kind: "user" as const,
});

describe("profile network discovery", () => {
	it("stores the complete snapshot and enqueues only missing profiles", async () => {
		const store = {
			replaceSnapshot: vi.fn(async () => [member(2)]),
			markComplete: vi.fn(async () => {}),
			markFailed: vi.fn(async () => {}),
		};
		const requestIngestion = vi.fn(async () => ({}));
		const discover = createProfileNetworkDiscovery({
			store,
			resolveOwner: async () => ({ login: "owner", following: 2 }),
			fetchFollowing: async () => [member(1), member(2)],
			requestIngestion,
		});

		await expect(discover(job, { token: "token" })).resolves.toEqual({
			membersFound: 2,
			profilesEnqueued: 1,
		});
		expect(requestIngestion).toHaveBeenCalledWith({
			version: 1,
			githubNodeId: "U_2",
			login: "person-2",
		});
		expect(store.markComplete).toHaveBeenCalledWith("U_owner");
		expect(store.markFailed).not.toHaveBeenCalled();
	});

	it("never replaces a snapshot when GitHub pagination fails", async () => {
		const store = {
			replaceSnapshot: vi.fn(async () => []),
			markComplete: vi.fn(async () => {}),
			markFailed: vi.fn(async () => {}),
		};
		const discover = createProfileNetworkDiscovery({
			store,
			resolveOwner: async () => ({ login: "owner", following: 2 }),
			fetchFollowing: async () => {
				throw new Error("page two failed");
			},
			requestIngestion: async () => ({}),
		});

		await expect(discover(job, { token: "token" })).rejects.toThrow(
			"page two failed",
		);
		expect(store.replaceSnapshot).not.toHaveBeenCalled();
		expect(store.markFailed).toHaveBeenCalledWith(
			"U_owner",
			"Error: page two failed",
		);
	});

	it("never enqueues organizations returned by snapshot storage", async () => {
		const organization = {
			...member(2),
			githubNodeId: "O_2",
			kind: "org" as const,
		};
		const store = {
			replaceSnapshot: vi.fn(async () => [member(1), organization]),
			markComplete: vi.fn(async () => {}),
			markFailed: vi.fn(async () => {}),
		};
		const requestIngestion = vi.fn(async () => ({}));
		const discover = createProfileNetworkDiscovery({
			store,
			resolveOwner: async () => ({ login: "owner", following: 2 }),
			fetchFollowing: async () => [member(1), organization],
			requestIngestion,
		});

		await expect(discover(job, { token: "token" })).resolves.toEqual({
			membersFound: 1,
			profilesEnqueued: 1,
		});

		expect(requestIngestion).toHaveBeenCalledTimes(1);
		expect(requestIngestion).toHaveBeenCalledWith({
			version: 1,
			githubNodeId: "U_1",
			login: "person-1",
		});
	});

	it("uses the immutable owner's current login after a rename", async () => {
		const store = {
			replaceSnapshot: vi.fn(async () => []),
			markComplete: vi.fn(async () => {}),
			markFailed: vi.fn(async () => {}),
		};
		const fetchFollowing = vi.fn(async () => [member(1)]);
		const discover = createProfileNetworkDiscovery({
			store,
			resolveOwner: async () => ({
				login: "new-owner-login",
				following: 1,
			}),
			fetchFollowing,
			requestIngestion: async () => ({}),
		});

		await discover(job, { token: "token" });
		expect(fetchFollowing).toHaveBeenCalledWith(
			"new-owner-login",
			"token",
			undefined,
		);
		expect(store.replaceSnapshot).toHaveBeenCalledWith(
			"U_owner",
			[member(1)],
			expect.any(Date),
		);
	});

	it("rejects oversized networks before paginating GitHub", async () => {
		const store = {
			replaceSnapshot: vi.fn(async () => []),
			markComplete: vi.fn(async () => {}),
			markFailed: vi.fn(async () => {}),
		};
		const fetchFollowing = vi.fn(async () => []);
		const discover = createProfileNetworkDiscovery({
			store,
			resolveOwner: async () => ({ login: "owner", following: 251 }),
			fetchFollowing,
			requestIngestion: async () => ({}),
		});

		await expect(discover(job, { token: "token" })).rejects.toThrow(
			"exceeded 250 profiles",
		);
		expect(fetchFollowing).not.toHaveBeenCalled();
		expect(store.replaceSnapshot).not.toHaveBeenCalled();
		expect(
			isNetworkTooLargeFailure(
				"GitHubError: GitHub following lookup exceeded 10000 profiles.",
			),
		).toBe(true);
	});

	it("does not enumerate when worker admission finds a full queue", async () => {
		const store = {
			replaceSnapshot: vi.fn(async () => []),
			markComplete: vi.fn(async () => {}),
			markFailed: vi.fn(async () => {}),
		};
		const fetchFollowing = vi.fn(async () => [member(1)]);
		const discover = createProfileNetworkDiscovery({
			store,
			resolveOwner: async () => ({ login: "owner", following: 1 }),
			admit: async () => "busy",
			fetchFollowing,
			requestIngestion: async () => ({}),
		});

		await expect(discover(job, { token: "token" })).rejects.toThrow(
			"ingestion queue is busy",
		);
		expect(fetchFollowing).not.toHaveBeenCalled();
		expect(store.replaceSnapshot).not.toHaveBeenCalled();
	});
});
