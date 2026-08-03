/**
 * Static sponsor creative for the two paid slots: the developer board and the organization board.
 *
 * The creative lives in code — not a DB, not a CMS. A slot changes maybe once a quarter, a logo
 * has to be hosted somewhere regardless, and keeping it here means every change is a reviewable,
 * revertable commit. *Selling* a slot is a Stripe concern (`src/lib/sponsor.ts`); *showing* the
 * creative is this file. A fresh sale flips the /-/sponsoring page to "Booked" automatically, and
 * the entry below is added by hand once the sponsor mails their logo.
 *
 * An entry here is permission to show an ad, not proof the slot is still paid for: `SponsorRow`
 * hides the creative whenever Stripe reports the slot available, so a lapsed subscription can't
 * leave an ex-sponsor running for free. Do clear the stale entry anyway — the row falls back to
 * the creative whenever Stripe is unreachable.
 *
 * `null` = the slot has no paid creative right now → the leaderboards show a self-advertising
 * "empty slot" row linking to the /-/sponsoring pitch page.
 */
export type SponsorSlotId = "dev" | "org";

/** One arm of an optional client-side A/B test on a sponsor's tagline. */
export interface SponsorVariant {
	tagline: string;
	/** Outbound link for this arm (carries its own utm_content so clicks are attributable). */
	href: string;
}

export interface SponsorCreative {
	/** Product name, shown as the row title. */
	name: string;
	/** One-line tagline under the name (the control arm when `abVariants` is set). */
	tagline: string;
	/** Outbound link, already carrying any utm params (the control arm when `abVariants` is set). */
	href: string;
	/** Logo image URL (the sponsor mails it; hosted on their domain or in /public). */
	logo: string;
	/** Users' avatars are round, orgs' are square — match the board the slot sits on. */
	logoShape?: "round" | "square";
	/**
	 * Optional A/B test on the tagline. When present the row flips to a random arm on the client;
	 * `tagline`/`href` above stay the SSR/first-paint control so hydration matches.
	 */
	abVariants?: readonly SponsorVariant[];
}

export const SPONSORS: Record<SponsorSlotId, SponsorCreative | null> = {
	// The Rebates.ai deal ended when its subscription lapsed — the board shows the self-advertising
	// empty row again. Its creative (logo, the slot-5 tagline A/B test, utm_content arms) is in git
	// history if the deal comes back.
	dev: null,
	// No paid org sponsor yet → the board shows the self-advertising empty row. When the org slot
	// sells via Stripe, drop the sponsor's creative here and deploy.
	org: null,
};
