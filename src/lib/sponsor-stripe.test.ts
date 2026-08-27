import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { loadPaymentLinkSlot } from "#/lib/sponsor-stripe";

const currentPrice = {
	id: "price_current",
	unit_amount: 1000,
	currency: "usd",
	recurring: { interval: "week", interval_count: 1 },
} as Stripe.Price;

function stripeWith({
	active = true,
	price = currentPrice,
	subscriptions = [],
}: {
	active?: boolean;
	price?: Stripe.Price | null;
	subscriptions?: Array<Pick<Stripe.Subscription, "status">>;
} = {}) {
	const retrieve = vi.fn(async () => ({
		active,
		url: "https://buy.stripe.com/current-link",
	}));
	const listLineItems = vi.fn(async () => ({
		data: [{ price }],
		has_more: false,
	}));
	const listSubscriptions = vi.fn(async () => ({ data: subscriptions }));
	return {
		stripe: {
			paymentLinks: { retrieve, listLineItems },
			subscriptions: { list: listSubscriptions },
		} as unknown as Pick<Stripe, "paymentLinks" | "subscriptions">,
		retrieve,
		listLineItems,
		listSubscriptions,
	};
}

describe("loadPaymentLinkSlot", () => {
	it("uses the Payment Link as the source of its URL, price, and occupancy key", async () => {
		const { stripe, retrieve, listLineItems, listSubscriptions } = stripeWith();

		await expect(
			loadPaymentLinkSlot("dev", "plink_dev", stripe),
		).resolves.toEqual({
			id: "dev",
			status: "available",
			buyUrl: "https://buy.stripe.com/current-link",
			price: {
				unitAmount: 1000,
				currency: "usd",
				interval: "week",
				intervalCount: 1,
			},
		});
		expect(retrieve).toHaveBeenCalledWith("plink_dev");
		expect(listLineItems).toHaveBeenCalledWith("plink_dev", { limit: 2 });
		expect(listSubscriptions).toHaveBeenCalledWith({
			price: "price_current",
			status: "all",
			limit: 100,
		});
	});

	it("marks the slot booked from subscriptions on the Payment Link's current price", async () => {
		const { stripe } = stripeWith({ subscriptions: [{ status: "active" }] });

		await expect(
			loadPaymentLinkSlot("org", "plink_org", stripe),
		).resolves.toMatchObject({ id: "org", status: "booked" });
	});

	it("keeps an inactive Link booked after its Price changes", async () => {
		const { stripe } = stripeWith({ active: false, subscriptions: [] });

		await expect(
			loadPaymentLinkSlot("dev", "plink_dev", stripe),
		).resolves.toMatchObject({ id: "dev", status: "booked" });
	});
});
