import { describe, expect, it } from "vitest";
import {
	isNetworkTooLargeFailure,
	networkAdmission,
} from "#/lib/profile-network-limits";

describe("network expansion limits", () => {
	it("automatically admits a small network while the queue has room", () => {
		expect(networkAdmission(66, 900)).toBe("allowed");
	});

	it("rejects oversized networks before they can fan out", () => {
		expect(networkAdmission(251, 0)).toBe("too_large");
	});

	it("pauses new discovery before the queue exceeds its budget", () => {
		expect(networkAdmission(66, 935)).toBe("busy");
	});

	it("recognizes failures from the old 10,000-profile limit", () => {
		expect(
			isNetworkTooLargeFailure(
				"GitHubError: GitHub following lookup exceeded 10000 profiles.",
			),
		).toBe(true);
	});
});
