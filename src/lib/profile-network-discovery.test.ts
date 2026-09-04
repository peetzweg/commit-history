import { describe, expect, it, vi } from "vitest";
import { createProfileNetworkDiscovery } from "#/lib/profile-network-discovery";

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
});
