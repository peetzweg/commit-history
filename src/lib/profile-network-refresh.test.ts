import { describe, expect, it } from "vitest";
import { shouldRequestProfileNetwork } from "#/lib/profile-network-refresh";

const now = new Date("2026-09-19T12:00:00Z");

describe("shouldRequestProfileNetwork", () => {
	it("retries an abandoned request even when its snapshot was saved", () => {
		expect(
			shouldRequestProfileNetwork(
				{
					enumeratedAt: new Date("2026-09-19T11:59:00Z"),
					refreshRequestedAt: new Date("2026-09-19T11:54:00Z"),
					lastError: null,
				},
				now,
			),
		).toBe(true);
	});

	it("does not retry a completed fresh snapshot", () => {
		expect(
			shouldRequestProfileNetwork(
				{
					enumeratedAt: new Date("2026-09-19T11:59:00Z"),
					refreshRequestedAt: null,
					lastError: null,
				},
				now,
			),
		).toBe(false);
	});

	it("automatically starts an untouched profile", () => {
		expect(shouldRequestProfileNetwork(undefined, now)).toBe(true);
	});

	it("recovers an abandoned explicit discovery on a later page view", () => {
		expect(
			shouldRequestProfileNetwork(
				{
					enumeratedAt: new Date("2026-09-19T11:59:00Z"),
					refreshRequestedAt: new Date("2026-09-19T11:54:00Z"),
					lastError: null,
				},
				now,
			),
		).toBe(true);
	});

	it("retries legacy oversized-network failures after the cap is removed", () => {
		expect(
			shouldRequestProfileNetwork(
				{
					enumeratedAt: null,
					refreshRequestedAt: new Date("2026-09-19T11:54:00Z"),
					lastError:
						"NetworkTooLargeError: GitHub following lookup exceeded 10000 profiles.",
				},
				now,
			),
		).toBe(true);
	});
});
