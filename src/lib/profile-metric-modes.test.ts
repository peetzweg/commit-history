import { describe, expect, it } from "vitest";
import type { LookupResult } from "#/lib/org";
import { profileMetricModes } from "#/lib/profile-metric-modes";

describe("profileMetricModes", () => {
	it("hides the picker before a profile loader resolves", () => {
		expect(profileMetricModes(undefined)).toBeNull();
	});

	it("hides the picker while any profile is still building", () => {
		const lookup = {
			kind: "users",
			users: [
				{
					login: "new-user",
					history: null,
					error: null,
					suspended: false,
					unreachable: false,
					ranks: {},
					building: { monthsFetched: 3, monthsTotal: 12 },
				},
			],
		} satisfies LookupResult;

		expect(profileMetricModes(lookup)).toBeNull();
	});
});
