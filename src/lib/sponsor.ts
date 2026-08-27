import { createServerFn } from "@tanstack/react-start";
import type Stripe from "stripe";
import type { SponsorSlotId } from "#/content/sponsors";
import { loadPaymentLinkSlot, type SlotState } from "#/lib/sponsor-stripe";

export type { SlotState, SlotStatus } from "#/lib/sponsor-stripe";

/**
 * Live per-slot sponsorship status, read from Stripe. Powers the "Rent this slot" / "Booked"
 * cards on the /-/sponsoring page, and gates the leaderboard creative (`SponsorRow`) so a slot
 * offered for rent can never still be running the previous sponsor's ad. Which creative a booked
 * slot shows stays a static, manual concern (`src/content/sponsors.ts`) — this module only decides
 * whether a slot is currently for sale.
 *
 * No database: a slot's truth lives entirely in Stripe. Env maps each slot to one Payment Link;
 * the Link supplies its hosted URL and current recurring Price. "Booked" is derived from an active
 * subscription existing on that Price, NOT from the Payment Link's `active` flag — that closes the
 * checkout→webhook race, where a link is briefly still enabled after a purchase completes. Missing
 * config or any Stripe failure yields `"unknown"`, which the page renders as the mailto fallback —
 * this feature never throws a page.
 *
 * The Stripe SDK is Node-only and this module sits in a client-reachable import graph (the
 * /-/sponsoring route imports the RPC stub + types), so `stripe` is loaded via dynamic import
 * behind a server check — same idiom as `src/lib/db/index.ts` (the "Buffer is not defined"
 * incident). A static top-level import would drag the SDK into the browser bundle.
 */

interface SlotEnv {
	/** Source of the slot's checkout URL, recurring Price, occupancy key, and webhook identity. */
	linkId?: string;
}

/** Per-slot Stripe wiring, read from env at call time (never at module load — values arrive late
 *  in Coolify). Shared by the status lookup and the webhook. */
export function sponsorSlotEnv(): Record<SponsorSlotId, SlotEnv> {
	return {
		dev: {
			linkId: process.env.SPONSOR_DEV_PAYMENT_LINK_ID,
		},
		org: {
			linkId: process.env.SPONSOR_ORG_PAYMENT_LINK_ID,
		},
	};
}

const SLOT_IDS: readonly SponsorSlotId[] = ["dev", "org"];

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
	if (!stripe || !env.linkId) return { id, status: "unknown" };
	return loadPaymentLinkSlot(id, env.linkId, stripe);
}

// Module-level cache: one set of Stripe lookups per minute, shared across the server process (the
// webhook busts it on a sale so the page flips immediately, not after the full 60s). Purely a perf
// shim — the truth is always Stripe, so a cold cache after a restart just refills on next read.
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
