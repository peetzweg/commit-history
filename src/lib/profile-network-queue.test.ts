import { describe, expect, it } from "vitest";
import { parseProfileNetworkJob } from "#/lib/profile-network-queue";

describe("parseProfileNetworkJob", () => {
	it("normalizes a versioned immutable-owner payload", () => {
		expect(
			parseProfileNetworkJob({
				version: 1,
				ownerGithubNodeId: " U_owner ",
				login: "peetzweg",
			}),
		).toEqual({
			version: 1,
			ownerGithubNodeId: "U_owner",
			login: "peetzweg",
		});
	});

	it("rejects malformed and future payloads", () => {
		for (const value of [
			null,
			{},
			{ version: 2, ownerGithubNodeId: "U_owner", login: "peetzweg" },
			{ version: 1, ownerGithubNodeId: "", login: "peetzweg" },
			{ version: 1, ownerGithubNodeId: "U_owner", login: "bad/login" },
		]) {
			expect(() => parseProfileNetworkJob(value)).toThrow();
		}
	});
});
