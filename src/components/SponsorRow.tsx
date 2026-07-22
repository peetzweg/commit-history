import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import {
	SPONSORS,
	type SponsorCreative,
	type SponsorSlotId,
} from "#/content/sponsors";
import { cn } from "#/lib/utils";

/**
 * The sponsor slot row shown after rank 5 on a leaderboard.
 *
 * Driven purely by the static creative in `src/content/sponsors.ts`: a booked slot renders the
 * sponsor's creative, an empty slot advertises itself and links to the /-/sponsoring pitch page.
 * Reused across the developer board, the organization board, and each organization's internal
 * member board, so the same paid slot is seen everywhere its board appears.
 *
 * Live "is it sold" status (the "Rent this slot" buttons) is a separate, Stripe-driven concern on
 * the /-/sponsoring page (`src/lib/sponsor.ts`) — swapping the creative here stays a manual,
 * reviewable commit made once a sponsor mails their logo.
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
	return creative ? (
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
