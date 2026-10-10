import { describe, expect, it, vi } from "vitest";
import {
	createProfileNetworkDiscovery,
	NetworkDiscoveryDeferred,
} from "#/lib/profile-network-discovery";

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

	it("defers while the queue is full without spending a GitHub request", async () => {
		const resolveOwner = vi.fn(async () => ({ login: "owner", following: 1 }));
		const fetchFollowing = vi.fn(async () => [member(1)]);
		const storage = store();
		const discover = createProfileNetworkDiscovery({
			store: storage,
			resolveOwner,
			admit: async () => "busy" as const,
			fetchFollowing,
		});
		const error = await discover(job, { token: "token" }).catch((e) => e);
		expect(error).toBeInstanceOf(NetworkDiscoveryDeferred);
		expect(error.reason).toBe("profile_queue_busy");
		expect(error.retryAt.getTime()).toBeGreaterThan(Date.now());
		expect(resolveOwner).not.toHaveBeenCalled();
		expect(fetchFollowing).not.toHaveBeenCalled();
		expect(storage.markFailed).not.toHaveBeenCalled();
	});

	it("defers below the token floor without spending a GitHub request", async () => {
		const resolveOwner = vi.fn(async () => ({ login: "owner", following: 1 }));
		const resetAt = new Date(Date.now() + 30 * 60_000);
		const discover = createProfileNetworkDiscovery({
			store: store(),
			resolveOwner,
			admit: async () => "allowed" as const,
			budgetDeferral: async () => resetAt,
			fetchFollowing: async () => [member(1)],
		});
		const error = await discover(job, { token: "token" }).catch((e) => e);
		expect(error).toBeInstanceOf(NetworkDiscoveryDeferred);
		expect(error.reason).toBe("rate_limit_floor");
		expect(error.retryAt).toBe(resetAt);
		expect(resolveOwner).not.toHaveBeenCalled();
	});
});
