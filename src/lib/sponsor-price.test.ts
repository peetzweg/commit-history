import { describe, expect, it } from "vitest";
import { formatSponsorPrice } from "#/lib/sponsor-price";

describe("formatSponsorPrice", () => {
	it("formats a monthly dollar price without redundant cents", () => {
		expect(
			formatSponsorPrice({
				unitAmount: 9900,
				currency: "usd",
				interval: "month",
				intervalCount: 1,
			}),
		).toBe("$99/month");
	});

	it("respects currencies without minor units", () => {
		expect(
			formatSponsorPrice({
				unitAmount: 12000,
				currency: "jpy",
				interval: "month",
				intervalCount: 1,
			}),
		).toBe("¥12,000/month");
	});

	it("includes non-default interval counts", () => {
		expect(
			formatSponsorPrice({
				unitAmount: 25000,
				currency: "eur",
				interval: "month",
				intervalCount: 3,
			}),
		).toBe("€250/3 months");
	});
});
