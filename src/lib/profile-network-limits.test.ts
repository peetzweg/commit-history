import { describe, expect, it } from "vitest";
import { networkAdmission } from "#/lib/profile-network-limits";

describe("network expansion limits", () => {
	it("admits another bounded batch regardless of total network size", () => {
		expect(networkAdmission(900)).toBe("allowed");
	});
	it("pauses before the profile queue exceeds its budget", () => {
		expect(networkAdmission(951)).toBe("busy");
	});
});
