export interface SponsorPrice {
	/** Amount in the currency's smallest unit, matching Stripe's `unit_amount`. */
	unitAmount: number;
	currency: string;
	interval: "day" | "week" | "month" | "year";
	intervalCount: number;
}

/** Format the recurring Stripe price consistently wherever a sponsor slot is advertised. */
export function formatSponsorPrice(price: SponsorPrice): string {
	const currencyDigits =
		new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: price.currency,
		}).resolvedOptions().maximumFractionDigits ?? 2;
	const amount = price.unitAmount / 10 ** currencyDigits;
	const formattedAmount = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: price.currency,
		currencyDisplay: "narrowSymbol",
		minimumFractionDigits: 0,
		maximumFractionDigits: currencyDigits,
	}).format(amount);
	const period =
		price.intervalCount === 1
			? price.interval
			: `${price.intervalCount} ${price.interval}s`;

	return `${formattedAmount}/${period}`;
}
