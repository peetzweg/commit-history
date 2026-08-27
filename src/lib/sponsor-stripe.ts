import type Stripe from "stripe";
import type { SponsorSlotId } from "#/content/sponsors";
import type { SponsorPrice } from "#/lib/sponsor-price";

export type SlotStatus = "available" | "booked" | "unknown";

export interface SlotState {
	id: SponsorSlotId;
	status: SlotStatus;
	/** The recurring Price currently attached to the slot's Payment Link. */
	price?: SponsorPrice;
	/** Present only when status === "available": Stripe's current hosted Payment Link URL. */
	buyUrl?: string;
}

type SponsorStripe = Pick<Stripe, "paymentLinks" | "subscriptions">;

const OCCUPIED_STATUSES = new Set<Stripe.Subscription.Status>([
	"active",
	"trialing",
	"past_due",
]);

/**
 * Resolve all mutable slot data from its Payment Link. The Link owns both the checkout URL and its
 * current recurring Price, so editing it in Stripe cannot leave a stale advertised price in env.
 */
export async function loadPaymentLinkSlot(
	id: SponsorSlotId,
	linkId: string,
	stripe: SponsorStripe,
): Promise<SlotState> {
	const [link, lineItems] = await Promise.all([
		stripe.paymentLinks.retrieve(linkId),
		stripe.paymentLinks.listLineItems(linkId, { limit: 2 }),
	]);
	// Sponsor checkout deliberately has one required recurring line item. Refuse an ambiguous Link
	// instead of advertising one amount while Stripe charges for a different combination of items.
	if (lineItems.has_more || lineItems.data.length !== 1) {
		throw new Error(
			`Sponsor Payment Link ${linkId} must have exactly one line item`,
		);
	}
	const stripePrice = lineItems.data[0]?.price;
	const price = sponsorPrice(stripePrice);
	if (!stripePrice || !price) {
		throw new Error(
			`Sponsor Payment Link ${linkId} must use a fixed recurring Price`,
		);
	}

	// The current line item's Price is also the slot identity used for occupancy. The subscription
	// list filter accepts one status, so fetch all and keep the live-ish statuses locally.
	const subs = await stripe.subscriptions.list({
		price: stripePrice.id,
		status: "all",
		limit: 100,
	});
	const occupied = subs.data.some((subscription) =>
		OCCUPIED_STATUSES.has(subscription.status),
	);
	return occupied
		? { id, status: "booked", price }
		: { id, status: "available", buyUrl: link.url, price };
}

function sponsorPrice(price: Stripe.Price | null): SponsorPrice | undefined {
	if (!price?.recurring || price.unit_amount === null) return undefined;
	return {
		unitAmount: price.unit_amount,
		currency: price.currency,
		interval: price.recurring.interval,
		intervalCount: price.recurring.interval_count,
	};
}
