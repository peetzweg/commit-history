import { createFileRoute, Link } from "@tanstack/react-router";

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

// Site analytics, collected since June 27, 2026. Update LAST_UPDATED when refreshing numbers.
const LAST_UPDATED = "July 14, 2026";
const STATS = [
	{ value: "15k", label: "unique visitors" },
	{ value: "57k", label: "page views" },
	{ value: "1:32", label: "avg. visit duration" },
	{ value: "38%", label: "bounce rate" },
] as const;

export const Route = createFileRoute("/-/sponsoring")({
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
				One sponsor slot, rendered like a leaderboard entry, in 5th place of
				both the developer and the organization leaderboard — the first thing
				people scroll past on every visit.
			</p>

			{/* CTA up top: interested sponsors shouldn't have to scroll to find the contact. */}
			<div className="mt-6 flex flex-wrap items-center gap-3">
				<a href={MAILTO} className="btn-primary">
					Get in touch
				</a>
				<span className="text-sm text-muted-foreground">{CONTACT}</span>
			</div>

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
				Interested?{" "}
				<a href={MAILTO} className="font-medium text-foreground underline">
					Send a mail to {CONTACT}
				</a>{" "}
				and we’ll figure out the rest.
			</p>
		</main>
	);
}
