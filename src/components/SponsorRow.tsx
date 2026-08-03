import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import {
	SPONSORS,
	type SponsorCreative,
	type SponsorSlotId,
} from "#/content/sponsors";
import { sponsorSlotsQueryOptions } from "#/lib/sponsor";
import { cn } from "#/lib/utils";

/**
 * The sponsor slot row shown after rank 5 on a leaderboard.
 *
 * Two inputs: the static creative in `src/content/sponsors.ts` (what a booked slot looks like) and
 * the live Stripe status from `src/lib/sponsor.ts` (whether the slot is still sold). No creative,
 * or a slot Stripe says is available, renders the self-advertising empty row linking to the
 * /-/sponsoring pitch page. Reused across the developer board, the organization board, and each
 * organization's internal member board, so the same paid slot is seen everywhere its board appears.
 *
 * The status check exists because the two used to be fully decoupled, and a lapsed subscription
 * left the old sponsor's ad running on the boards while /-/sponsoring already offered the same slot
 * for rent. Putting a *new* creative up is still a manual, reviewable commit (nobody can invent a
 * logo from a Stripe event); taking a lapsed one *down* needs no creative, so it happens by itself.
 *
 * Takes an optional `ref` because on the home boards it's a direct child of AnimatePresence
 * (mode="popLayout"), which attaches a ref to each child to measure it.
 */
export function SponsorRow({
	slot,
	ref,
}: {
	slot: SponsorSlotId;
	ref?: React.Ref<HTMLLIElement>;
}) {
	const creative = SPONSORS[slot];
	// Skipped when there is no creative: an empty slot renders the same either way, so the common
	// case costs no RPC — and the request only ever fires for a slot with an ad to justify.
	const { data } = useQuery({
		...sponsorSlotsQueryOptions,
		enabled: creative !== null,
	});
	const status = data?.find((s) => s.id === slot)?.status ?? "unknown";
	// Only a definitive "available" pulls the ad. On the server, during the first paint, and through
	// any Stripe outage the status reads "unknown" — a paying sponsor keeps their row regardless.
	return creative && status !== "available" ? (
		<BookedRow creative={creative} ref={ref} />
	) : (
		<EmptyRow ref={ref} />
	);
}

function BookedRow({
	creative,
	ref,
}: {
	creative: SponsorCreative;
	ref?: React.Ref<HTMLLIElement>;
}) {
	// Default to the control arm (index 0) on the server + first paint so hydration matches, then
	// flip to a random arm on the client. Math.random() during render would desync SSR/hydration.
	const [arm, setArm] = useState(0);
	const variants = creative.abVariants;
	useEffect(() => {
		if (variants && variants.length > 1) {
			setArm(Math.floor(Math.random() * variants.length));
		}
	}, [variants]);
	const active = variants?.[arm];
	const tagline = active?.tagline ?? creative.tagline;
	const href = active?.href ?? creative.href;

	return (
		<motion.li
			ref={ref}
			layout
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ type: "spring", stiffness: 600, damping: 40 }}
			className="border-border border-b bg-muted/40"
		>
			<a
				href={href}
				target="_blank"
				rel="sponsored nofollow noopener"
				className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted"
			>
				{/* "Ad" gutter is dropped on mobile to give the title room (it reads cramped otherwise);
				    "Sponsored" on the right keeps the disclosure. */}
				<span className="hidden w-6 items-center justify-center text-[10px] uppercase tracking-wide text-muted-foreground sm:flex">
					Ad
				</span>
				<img
					src={creative.logo}
					alt={creative.name}
					className={cn(
						"h-8 w-8 shrink-0 border border-border object-cover",
						creative.logoShape === "square" ? "rounded-lg" : "rounded-full",
					)}
				/>
				{/* Title + tagline on two lines in a lighter weight than the usernames, so the block
				    matches the logo height and doesn't shout as loud as a real leaderboard entry. */}
				<span className="min-w-0 flex-1">
					<span className="block truncate">{creative.name}</span>
					<span className="block truncate text-xs text-muted-foreground">
						{tagline}
					</span>
				</span>
				<span className="shrink-0 text-right text-xs text-muted-foreground">
					Sponsored
				</span>
			</a>
		</motion.li>
	);
}

function EmptyRow({ ref }: { ref?: React.Ref<HTMLLIElement> }) {
	return (
		<motion.li
			ref={ref}
			layout
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ type: "spring", stiffness: 600, damping: 40 }}
			className="border-border border-b bg-muted/40"
		>
			<Link
				to="/-/sponsoring"
				className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted"
			>
				{/* "Ad" gutter is dropped on mobile to give the title room (it reads cramped otherwise);
				    the right-hand label keeps the disclosure. */}
				<span className="hidden w-6 items-center justify-center text-[10px] uppercase tracking-wide text-muted-foreground sm:flex">
					Ad
				</span>
				{/* Dashed placeholder where the sponsor's logo would sit — reads as "empty". */}
				<span className="h-8 w-8 shrink-0 rounded-full border border-border border-dashed" />
				<span className="min-w-0 flex-1">
					<span className="block truncate">This sponsor slot is empty</span>
					<span className="block truncate text-xs text-muted-foreground">
						Put your product in front of thousands of developers
					</span>
				</span>
				<span className="shrink-0 text-right text-xs text-muted-foreground">
					Sponsoring
				</span>
			</Link>
		</motion.li>
	);
}
