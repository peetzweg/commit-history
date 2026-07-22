import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SponsorSlotId } from "#/content/sponsors";
import { getSponsorSlots, type SlotState } from "#/lib/sponsor";

const SITE = "https://commit-history.com";
const TITLE = "Sponsoring commit-history.com";
const DESCRIPTION =
	"Put your product in front of a developer-first audience: 15k unique visitors and 57k page views in under a month, in a sponsor slot on both leaderboards.";
// Lives under the reserved /-/ namespace like all editorial content: "-" can never be a
// GitHub login, so this page can't shadow the $user route (the old single-segment
// /sponsoring URL 301s here — see sponsoring.tsx).
const URL = `${SITE}/-/sponsoring`;
// Static card built by scripts/generate-og.ts — keep its copy in sync with TITLE/DESCRIPTION.
const OG_IMAGE = `${SITE}/og/sponsoring.png`;

const CONTACT = "phil.czek@gmail.com";
const MAILTO = `mailto:${CONTACT}?subject=${encodeURIComponent("Sponsoring commit-history.com")}`;
// Prefilled logo email for the post-purchase confirmation — the buyer's one remaining step.
const MAILTO_LOGO = `mailto:${CONTACT}?subject=${encodeURIComponent(
	"My sponsor logo for commit-history.com",
)}&body=${encodeURIComponent(
	"Hi! I just rented a sponsor slot. My logo is attached (SVG or PNG).\n\nProduct name:\nTagline:\nLink URL:",
)}`;

// Site analytics, collected since June 27, 2026. Update LAST_UPDATED when refreshing numbers.
const LAST_UPDATED = "July 14, 2026";
const STATS = [
	{ value: "15k", label: "unique visitors" },
	{ value: "57k", label: "page views" },
	{ value: "1:32", label: "avg. visit duration" },
	{ value: "38%", label: "bounce rate" },
] as const;

interface SponsoringSearch {
	/** Set by the Stripe Payment Link's after-payment redirect (?thanks=1) → shows the banner. */
	thanks?: true;
}

export const Route = createFileRoute("/-/sponsoring")({
	validateSearch: (search: Record<string, unknown>): SponsoringSearch =>
		search.thanks === "1" || search.thanks === true ? { thanks: true } : {},
	head: () => ({
		meta: [
			{ title: `${TITLE} · Commit History` },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:url", content: URL },
			{ property: "og:image", content: OG_IMAGE },
			{ property: "og:image:alt", content: TITLE },
			{ name: "twitter:title", content: TITLE },
			{ name: "twitter:description", content: DESCRIPTION },
			{ name: "twitter:image", content: OG_IMAGE },
			{ name: "twitter:image:alt", content: TITLE },
		],
		links: [{ rel: "canonical", href: URL }],
	}),
	component: SponsoringPage,
});

function SponsoringPage() {
	const { thanks } = Route.useSearch();
	// After a purchase (?thanks=1) the whole page becomes a focused confirmation — the pitch and
	// the slot cards are hidden so the one remaining step (email the logo) can't be missed. Hiding
	// the cards also sidesteps the confusing moment where the buyer's own slot still reads
	// "Available" until the webhook busts the status cache.
	if (thanks) return <ThanksView />;
	return (
		<main className="mx-auto max-w-3xl px-6 py-12">
			<Link
				to="/"
				className="text-sm text-muted-foreground hover:text-foreground"
			>
				← commit-history
			</Link>
			<h1 className="mt-6 text-3xl font-bold leading-tight">
				Sponsoring{" "}
				<span className="font-hand font-normal text-primary">
					commit-history.com
				</span>
			</h1>
			<p className="mt-3 text-muted-foreground">
				One sponsor slot on each leaderboard, rendered like a leaderboard entry
				in 5th place of the developer and the organization board — the first
				thing people scroll past on every visit.
			</p>

			{/* Live per-slot status: rent on the spot when a slot is open, mailto fallback otherwise. */}
			<SlotsSection />

			<h2 className="mt-12 text-xl font-semibold">The numbers</h2>
			<p className="mt-2 text-muted-foreground">
				We’ve been collecting analytics since June 27, 2026 — so in not even a
				month (last updated {LAST_UPDATED}):
			</p>
			<dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
				{STATS.map((s) => (
					<div key={s.label} className="rounded-md border p-4 text-center">
						<dd className="text-2xl font-bold tabular-nums">{s.value}</dd>
						<dt className="mt-1 text-xs text-muted-foreground">{s.label}</dt>
					</div>
				))}
			</dl>

			<h2 className="mt-12 text-xl font-semibold">The audience</h2>
			<p className="mt-2 text-muted-foreground">
				Mainly developers — people plotting their own commit history, comparing
				themselves on the leaderboards, and sharing profiles with each other. A
				visit duration of a minute and a half and a bounce rate as low as 38%
				mean visitors actually stick around and explore. Beyond developers, the
				leaderboards also draw companies and recruiters looking for talent — an
				audience that’s hard to reach anywhere else.
			</p>

			<h2 className="mt-12 text-xl font-semibold">The slot</h2>
			<p className="mt-2 text-muted-foreground">
				Your logo, product name, and a one-line tagline, clearly disclosed as
				sponsored, linking out to your site. It sits in 5th place of the{" "}
				<Link to="/" className="underline hover:text-foreground">
					developer leaderboard
				</Link>{" "}
				and the{" "}
				<Link
					to="/"
					search={{ kind: "org" }}
					className="underline hover:text-foreground"
				>
					organization leaderboard
				</Link>
				, so it’s on screen right where everyone looks.
			</p>

			<p className="mt-12 text-muted-foreground">
				Questions, or want to sort out a logo and the details first?{" "}
				<a href={MAILTO} className="font-medium text-foreground underline">
					Send a mail to {CONTACT}
				</a>{" "}
				and we’ll figure out the rest.
			</p>
		</main>
	);
}

// Copy shown alongside each slot's status card.
const SLOT_META: Record<SponsorSlotId, { title: string; blurb: string }> = {
	dev: {
		title: "Slot #5 on the Developer Leaderboard",
		blurb: "The sponsor row in 5th place, seen on every visit.",
	},
	org: {
		title: "Slot #5 on the Organization Leaderboards",
		blurb: "Including each organization’s internal leaderboard.",
	},
};

const SLOT_ORDER: readonly SponsorSlotId[] = ["dev", "org"];

/**
 * The two slot cards with live status. Loads client-side (no initialData) so the page stays
 * prerendered — the card starts on the mailto fallback and upgrades to "Rent this slot" / "Booked"
 * once Stripe answers. Any unconfigured/failed slot simply stays on the fallback.
 */
function SlotsSection() {
	const { data } = useQuery({
		queryKey: ["sponsor-slots"],
		queryFn: () => getSponsorSlots(),
		staleTime: 60_000,
	});
	const byId = new Map((data ?? []).map((s) => [s.id, s]));
	return (
		<section className="mt-10">
			<h2 className="text-xl font-semibold">The slots</h2>
			<p className="mt-2 text-muted-foreground">
				Two slots, one sponsor each. Rent one and it’s yours until you cancel —
				billed monthly, no double-booking.
			</p>
			<div className="mt-6 grid gap-4 sm:grid-cols-2">
				{SLOT_ORDER.map((id) => (
					<SlotCard key={id} id={id} state={byId.get(id)} />
				))}
			</div>
		</section>
	);
}

function SlotCard({ id, state }: { id: SponsorSlotId; state?: SlotState }) {
	const meta = SLOT_META[id];
	const status = state?.status ?? "unknown";
	return (
		<div className="flex flex-col rounded-lg border p-5">
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-semibold">{meta.title}</h3>
				{status === "available" && (
					<span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
						Available
					</span>
				)}
				{status === "booked" && (
					<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
						Booked
					</span>
				)}
			</div>
			<p className="mt-1 flex-1 text-sm text-muted-foreground">{meta.blurb}</p>
			<div className="mt-4">
				{status === "available" && state?.buyUrl ? (
					// External Stripe-hosted checkout — full page nav, not client routing.
					<a
						href={state.buyUrl}
						className="btn-primary flex w-full justify-center"
					>
						Rent this slot
					</a>
				) : status === "booked" ? (
					<p className="text-sm text-muted-foreground">
						Taken right now.{" "}
						<a href={MAILTO} className="underline hover:text-foreground">
							Ask to be next
						</a>
						.
					</p>
				) : (
					// Unknown: Stripe unconfigured or unreachable → the reliable mailto path.
					<a href={MAILTO} className="btn-secondary flex w-full justify-center">
						Get in touch
					</a>
				)}
			</div>
		</div>
	);
}

/**
 * The whole page after a successful Payment Link checkout (?thanks=1): a focused confirmation with
 * one clear call to action — email the logo — and nothing else competing for attention.
 */
function ThanksView() {
	return (
		<main className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-6 py-16 text-center">
			<div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-3xl">
				🎉
			</div>
			<h1 className="mt-6 text-3xl font-bold leading-tight">You’re in!</h1>
			<p className="mt-3 text-muted-foreground">
				Thanks for renting a sponsor slot on{" "}
				<span className="font-hand text-primary">commit-history.com</span>. Your
				subscription is active.
			</p>

			{/* The one remaining step, given its own emphasised card + primary action so it can't be
			    scrolled past or missed. */}
			<div className="mt-8 w-full rounded-xl border border-primary/30 bg-primary/5 p-6 text-left">
				<p className="font-semibold">One last step: send us your logo</p>
				<p className="mt-1 text-sm text-muted-foreground">
					Email your logo (SVG or PNG) — plus your product name, tagline, and
					link if you didn’t add them at checkout — and we’ll put your creative
					live on the leaderboard.
				</p>
				<a href={MAILTO_LOGO} className="btn-primary mt-4 inline-flex">
					Email your logo →
				</a>
				<p className="mt-3 text-xs text-muted-foreground">
					Or write to{" "}
					<a href={MAILTO_LOGO} className="underline hover:text-foreground">
						{CONTACT}
					</a>
				</p>
			</div>

			<Link
				to="/"
				className="mt-8 text-sm text-muted-foreground hover:text-foreground"
			>
				← Back to the leaderboard
			</Link>
		</main>
	);
}
