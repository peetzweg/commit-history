import { createFileRoute, Link } from "@tanstack/react-router";
import { articles } from "#/lib/content";

const SITE = "https://commit-history.com";
const TITLE = "GitHub contribution metrics, explained";
const DESCRIPTION =
	"What the numbers on a commit-history.com profile actually mean: commits, pull requests, reviews, repositories, and private contributions — in detail.";
const URL = `${SITE}/metrics`;
const OG_IMAGE = `${SITE}/og/metrics/index.png`;

export const Route = createFileRoute("/metrics/")({
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
		scripts: [
			{
				type: "application/ld+json",
				children: JSON.stringify({
					"@context": "https://schema.org",
					"@type": "CollectionPage",
					name: TITLE,
					description: DESCRIPTION,
					url: URL,
					mainEntity: {
						"@type": "ItemList",
						itemListElement: articles.map((a, i) => ({
							"@type": "ListItem",
							position: i + 1,
							name: a.title,
							url: `${SITE}/metrics/${a.slug}`,
						})),
					},
				}),
			},
		],
	}),
	component: MetricsIndex,
});

function MetricsIndex() {
	return (
		<main className="mx-auto max-w-3xl px-6 py-12">
			<Link
				to="/"
				className="text-sm text-muted-foreground hover:text-foreground"
			>
				← commit-history
			</Link>
			<h1 className="mt-6 text-3xl font-bold leading-tight">{TITLE}</h1>
			<p className="mt-3 text-muted-foreground">{DESCRIPTION}</p>
			<ul className="mt-10 flex flex-col divide-y divide-border">
				{articles.map((a) => (
					<li key={a.slug} className="py-6 first:pt-0 last:pb-0">
						<Link
							to="/metrics/$slug"
							params={{ slug: a.slug }}
							className="group block"
						>
							<h2 className="text-lg font-semibold group-hover:underline">
								{a.title}
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								{a.description}
							</p>
						</Link>
					</li>
				))}
			</ul>
		</main>
	);
}
