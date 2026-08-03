import { createServerFn } from "@tanstack/react-start";
import type Stripe from "stripe";
import type { SponsorSlotId } from "#/content/sponsors";

/**
 * Live per-slot sponsorship status, read from Stripe. Powers the "Rent this slot" / "Booked"
 * cards on the /-/sponsoring page, and gates the leaderboard creative (`SponsorRow`) so a slot
 * offered for rent can never still be running the previous sponsor's ad. Which creative a booked
 * slot shows stays a static, manual concern (`src/content/sponsors.ts`) — this module only decides
 * whether a slot is currently for sale.
 *
 * No database: a slot's truth lives entirely in Stripe (subscription state per price) plus env
 * (which price/link maps to which slot). "Booked" is derived from an active subscription existing,
 * NOT from the Payment Link's `active` flag — that closes the checkout→webhook race, where a link
 * is briefly still enabled after a purchase completes. Missing config or any Stripe failure yields
 * `"unknown"`, which the page renders as the mailto fallback — this feature never throws a page.
 *
 * The Stripe SDK is Node-only and this module sits in a client-reachable import graph (the
 * /-/sponsoring route imports the RPC stub + types), so `stripe` is loaded via dynamic import
 * behind a server check — same idiom as `src/lib/db/index.ts` (the "Buffer is not defined"
 * incident). A static top-level import would drag the SDK into the browser bundle.
 */

export type SlotStatus = "available" | "booked" | "unknown";

export interface SlotState {
	id: SponsorSlotId;
	status: SlotStatus;
	/** Present only when status === "available": the Stripe Payment Link to send the buyer to. */
	buyUrl?: string;
}

interface SlotEnv {
	/** Recurring price the slot's subscription is billed on — the "is it booked?" lookup key. */
	priceId?: string;
	/** Payment Link id — the webhook deactivates this on first purchase (single-occupancy). */
	linkId?: string;
	/** Payment Link URL — the page sends the buyer here. Not derivable from the id. */
	linkUrl?: string;
}

/** Per-slot Stripe wiring, read from env at call time (never at module load — values arrive late
 *  in Coolify). Shared by the status lookup and the webhook. */
export function sponsorSlotEnv(): Record<SponsorSlotId, SlotEnv> {
	return {
		dev: {
			priceId: process.env.SPONSOR_DEV_PRICE_ID,
			linkId: process.env.SPONSOR_DEV_PAYMENT_LINK_ID,
			linkUrl: process.env.SPONSOR_DEV_PAYMENT_LINK_URL,
		},
		org: {
			priceId: process.env.SPONSOR_ORG_PRICE_ID,
			linkId: process.env.SPONSOR_ORG_PAYMENT_LINK_ID,
			linkUrl: process.env.SPONSOR_ORG_PAYMENT_LINK_URL,
		},
	};
}

const SLOT_IDS: readonly SponsorSlotId[] = ["dev", "org"];

// A slot counts as taken while a subscription on its price is live-ish. past_due is included
// deliberately: a lapsing sponsor is still the occupant until Stripe cancels the sub outright.
const OCCUPIED_STATUSES = new Set<Stripe.Subscription.Status>([
	"active",
	"trialing",
	"past_due",
]);

/**
 * Build a Stripe client, or null when unusable (browser, or no secret key configured). Callers
 * treat null as "Stripe unconfigured" and degrade gracefully. Server-only; never call from the
 * client — the dynamic import keeps the SDK out of the browser bundle either way.
 */
export async function getStripeClient(): Promise<Stripe | null> {
	if (typeof window !== "undefined") return null;
	const key = process.env.STRIPE_SECRET_KEY;
	if (!key) return null;
	const { default: StripeCtor } = await import("stripe");
	return new StripeCtor(key);
}

async function computeSlot(
	id: SponsorSlotId,
	env: SlotEnv,
	stripe: Stripe | null,
): Promise<SlotState> {
	// Escape hatch for a slot sold outside Stripe (the legacy Rebates deal used it until that deal
	// lapsed): env forces "booked" so the slot isn't offered for rent and its creative keeps
	// running. Checked before Stripe so it holds even with Stripe unconfigured.
	if (id === "dev" && process.env.SPONSOR_DEV_SLOT_FORCE_BOOKED === "1") {
		return { id, status: "booked" };
	}
	if (!stripe || !env.priceId || !env.linkUrl) return { id, status: "unknown" };

	// status: "all" then filter locally — the list filter takes a single status, but a slot is
	// occupied by any of several. The slot has at most a handful of subs, so the page is tiny.
	const subs = await stripe.subscriptions.list({
		price: env.priceId,
		status: "all",
		limit: 100,
	});
	const occupied = subs.data.some((s) => OCCUPIED_STATUSES.has(s.status));
	return occupied
		? { id, status: "booked" }
		: { id, status: "available", buyUrl: env.linkUrl };
}

// Module-level cache: one Stripe round-trip per minute, shared across the server process (the
// webhook busts it on a sale so the page flips within the round-trip, not the full 60s). Purely a
// perf shim — the truth is always Stripe, so a cold cache after a restart just refills on next read.
const CACHE_MS = 60_000;
let cache: { at: number; slots: SlotState[] } | null = null;

/** Drop the cached slot statuses so the next read re-hits Stripe. Called by the webhook. */
export function bustSponsorSlotCache(): void {
	cache = null;
}

async function loadSlots(): Promise<SlotState[]> {
	const stripe = await getStripeClient().catch(() => null);
	const env = sponsorSlotEnv();
	return Promise.all(
		SLOT_IDS.map((id) =>
			// One slot's Stripe hiccup mustn't blank the other — isolate each to "unknown".
			computeSlot(id, env[id], stripe).catch(
				(): SlotState => ({ id, status: "unknown" }),
			),
		),
	);
}

/**
 * Per-slot sponsorship status for the /-/sponsoring page. GET server function, so it's covered by
 * the global same-origin + rate-limit middleware (`src/start.ts`). Called client-side (no
 * initialData) so the page stays prerendered and build never touches Stripe.
 */
export const getSponsorSlots = createServerFn({ method: "GET" }).handler(
	async (): Promise<SlotState[]> => {
		const now = Date.now();
		if (cache && now - cache.at < CACHE_MS) return cache.slots;
		const slots = await loadSlots();
		cache = { at: now, slots };
		return slots;
	},
);

/**
 * Shared react-query wiring, so the /-/sponsoring cards and every leaderboard sponsor row read one
 * cache instead of each firing their own RPC. staleTime matches the server-side cache window.
 */
export const sponsorSlotsQueryOptions = {
	queryKey: ["sponsor-slots"] as const,
	queryFn: () => getSponsorSlots(),
	staleTime: CACHE_MS,
};
