import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { type ComponentType, lazy, Suspense } from "react";
import { mdxComponents } from "#/components/MdxComponents";
import { getOrgArticleMeta, loadOrgArticle } from "#/lib/content";

/**
 * Organization-context explainer articles (src/content/organizations/*.mdx) — the org twins of
 * the /metrics/$slug pages. A separate collection on purpose: organization numbers are org-scoped
 * and public-member-only, so their definitions differ from the individual metric explainers.
 * Same URL policy as /metrics: bare /organizations stays a valid GitHub login on the $user route.
 * No per-article OG images (yet) — these fall back to the site-wide card.
 * Old /company/<slug> URLs 301 here via the company.$slug route.
 */

const SITE = "https://commit-history.com";

// One stable lazy component per slug — created on demand, cached at module level so
// re-renders don't recreate (and thereby remount) the article body.
type BodyComponent = ComponentType<{ components?: typeof mdxComponents }>;
const bodies = new Map<string, BodyComponent>();
function articleBody(slug: string): BodyComponent {
	let body = bodies.get(slug);
	if (!body) {
		body = lazy(() => {
			const load = loadOrgArticle(slug);
			if (!load) throw notFound();
			return load;
		});
		bodies.set(slug, body);
	}
	return body;
}

function formatDate(iso: string) {
	return new Date(iso).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

export const Route = createFileRoute("/organizations/$slug")({
	loader: ({ params }) => {
		const meta = getOrgArticleMeta(params.slug);
		if (!meta) throw notFound();
		return meta;
	},
	head: ({ params }) => {
		const meta = getOrgArticleMeta(params.slug);
		if (!meta) return {};
		const url = `${SITE}/organizations/${meta.slug}`;
		return {
			meta: [
				{ title: `${meta.title} · Commit History` },
				{ name: "description", content: meta.description },
				{ property: "og:type", content: "article" },
				{ property: "og:title", content: meta.title },
				{ property: "og:description", content: meta.description },
				{ property: "og:url", content: url },
				{ property: "article:published_time", content: meta.publishedAt },
				{ property: "article:modified_time", content: meta.updatedAt },
				{ name: "twitter:title", content: meta.title },
				{ name: "twitter:description", content: meta.description },
			],
			links: [{ rel: "canonical", href: url }],
			scripts: [
				{
					type: "application/ld+json",
					children: JSON.stringify([
						{
							"@context": "https://schema.org",
							"@type": "TechArticle",
							headline: meta.title,
							description: meta.description,
							datePublished: meta.publishedAt,
							dateModified: meta.updatedAt,
							mainEntityOfPage: url,
							author: {
								"@type": "Person",
								name: "Philip Poloczek",
								url: "https://github.com/peetzweg",
							},
							publisher: {
								"@type": "Organization",
								name: "Commit History",
								url: SITE,
								logo: {
									"@type": "ImageObject",
									url: `${SITE}/crown-180.png`,
								},
							},
						},
						{
							"@context": "https://schema.org",
							"@type": "BreadcrumbList",
							itemListElement: [
								{
									"@type": "ListItem",
									position: 1,
									name: "Commit History",
									item: SITE,
								},
								{ "@type": "ListItem", position: 2, name: meta.title },
							],
						},
					]),
				},
			],
		};
	},
	component: ArticlePage,
});

function ArticlePage() {
	const meta = Route.useLoaderData();
	const Body = articleBody(meta.slug);
	return (
		<main className="mx-auto max-w-3xl px-6 py-12">
			<nav aria-label="Breadcrumb">
				<Link
					to="/"
					search={{ kind: "org" }}
					className="text-sm text-muted-foreground hover:text-foreground"
				>
					← organization leaderboard
				</Link>
			</nav>
			<article className="mt-6">
				<header>
					<h1 className="text-3xl font-bold leading-tight">{meta.title}</h1>
					<p className="mt-3 text-muted-foreground">{meta.description}</p>
					<p className="mt-2 text-xs text-muted-foreground">
						Updated{" "}
						<time dateTime={meta.updatedAt}>{formatDate(meta.updatedAt)}</time>
					</p>
				</header>
				<div className="prose prose-neutral mt-8 max-w-none">
					<Suspense fallback={null}>
						<Body components={mdxComponents} />
					</Suspense>
				</div>
			</article>
		</main>
	);
}
