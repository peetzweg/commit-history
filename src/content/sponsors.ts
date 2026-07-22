/**
 * Static sponsor creative for the two paid slots: the developer board and the organization board.
 *
 * The creative lives in code — not a DB, not a CMS. A slot changes maybe once a quarter, a logo
 * has to be hosted somewhere regardless, and keeping it here means every change is a reviewable,
 * revertable commit. *Selling* a slot is a Stripe concern (`src/lib/sponsor.ts`); *showing* the
 * creative is this file. The two are deliberately decoupled: a fresh sale flips the /-/sponsoring
 * page to "Booked" automatically, while the row below is swapped by hand once the sponsor mails
 * their logo (same manual step the legacy Rebates deal uses today).
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

// Rebates.ai occupies the developer slot (legacy deal, not a Stripe subscription). The slot-5
// tagline A/B test rides along here — utm_content carries the arm so clicks are attributable.
const rebatesHref = (utmContent: string) =>
	`https://rebates.ai/?utm_source=commit-history.com&utm_medium=leaderboard&utm_campaign=commit-history_sponsorship&utm_content=${utmContent}`;

export const SPONSORS: Record<SponsorSlotId, SponsorCreative | null> = {
	dev: {
		name: "Rebates.ai",
		logo: "https://rebates.ai/brand/rebates-bandit.svg",
		logoShape: "round",
		// Arm "a" (control) is the SSR default; both arms live in abVariants for the client flip.
		tagline: "The ads in your terminal pay you",
		href: rebatesHref("slot5-test-79-a"),
		abVariants: [
			{
				tagline: "The ads in your terminal pay you",
				href: rebatesHref("slot5-test-79-a"),
			},
			{
				tagline: "Watch ads while coding. Get paid.",
				href: rebatesHref("slot5-test-79-b"),
			},
		],
	},
	// No paid org sponsor yet → the board shows the self-advertising empty row. When the org slot
	// sells via Stripe, drop the sponsor's creative here and deploy.
	org: null,
};
