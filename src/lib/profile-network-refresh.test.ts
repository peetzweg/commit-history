import { describe, expect, it } from "vitest";
import {
	shouldRequestProfileNetwork,
	shouldStartProfileNetworkDiscovery,
} from "#/lib/profile-network-refresh";

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

	it("does not expand an untouched profile during a passive page view", () => {
		expect(shouldStartProfileNetworkDiscovery(undefined, now, false)).toBe(
			false,
		);
		expect(shouldStartProfileNetworkDiscovery(undefined, now, true)).toBe(true);
	});

	it("recovers an abandoned explicit discovery on a later page view", () => {
		expect(
			shouldStartProfileNetworkDiscovery(
				{
					enumeratedAt: new Date("2026-09-19T11:59:00Z"),
					refreshRequestedAt: new Date("2026-09-19T11:54:00Z"),
					lastError: null,
				},
				now,
				false,
			),
		).toBe(true);
	});
});
