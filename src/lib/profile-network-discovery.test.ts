import { describe, expect, it, vi } from "vitest";
import { createProfileNetworkDiscovery } from "#/lib/profile-network-discovery";

const job = {
	version: 1 as const,
	ownerGithubNodeId: "U_owner",
	login: "owner",
};
const member = (index: number, kind: "user" | "org" = "user") => ({
	githubNodeId: `${kind === "user" ? "U" : "O"}_${index}`,
	login: `person-${index}`,
	avatarUrl: null,
	htmlUrl: null,
	kind,
});
const store = () => ({
	replaceSnapshot: vi.fn(async () => {}),
	markComplete: vi.fn(async () => {}),
	markFailed: vi.fn(async () => {}),
});

describe("profile network discovery", () => {
	it("saves all 301 identities, including org classification, for autonomous backfill", async () => {
		const members = Array.from({ length: 300 }, (_, index) => member(index));
		members.push(member(301, "org"));
		const storage = store();
		const discover = createProfileNetworkDiscovery({
			store: storage,
			resolveOwner: async () => ({ login: "owner", following: 301 }),
			fetchFollowing: async () => members,
		});
		await expect(discover(job, { token: "token" })).resolves.toEqual({
			membersFound: 300,
			profilesEnqueued: 0,
		});
		expect(storage.replaceSnapshot).toHaveBeenCalledWith(
			"U_owner",
			members,
			expect.any(Date),
		);
		expect(storage.markComplete).toHaveBeenCalledWith("U_owner");
	});

	it("keeps the previous snapshot when GitHub pagination fails", async () => {
		const storage = store();
		const discover = createProfileNetworkDiscovery({
			store: storage,
			resolveOwner: async () => ({ login: "owner", following: 300 }),
			fetchFollowing: async () => {
				throw new Error("page two failed");
			},
		});
		await expect(discover(job, { token: "token" })).rejects.toThrow(
			"page two failed",
		);
		expect(storage.replaceSnapshot).not.toHaveBeenCalled();
		expect(storage.markFailed).toHaveBeenCalledWith(
			"U_owner",
			"Error: page two failed",
		);
	});

	it("uses the owner's immutable id to resolve the current login", async () => {
		const fetchFollowing = vi.fn(async () => [member(1)]);
		await createProfileNetworkDiscovery({
			store: store(),
			resolveOwner: async () => ({ login: "new-owner-login", following: 1 }),
			fetchFollowing,
		})(job, { token: "token" });
		expect(fetchFollowing).toHaveBeenCalledWith(
			"new-owner-login",
			"token",
			undefined,
		);
	});

	it("pauses discovery while the queue is full", async () => {
		const fetchFollowing = vi.fn(async () => [member(1)]);
		const discover = createProfileNetworkDiscovery({
			store: store(),
			resolveOwner: async () => ({ login: "owner", following: 1000 }),
			admit: async () => "busy" as const,
			fetchFollowing,
		});
		await expect(discover(job, { token: "token" })).rejects.toThrow(
			"ingestion queue is busy",
		);
		expect(fetchFollowing).not.toHaveBeenCalled();
	});
});
