import { createFileRoute } from "@tanstack/react-router";
import { articles, orgArticles, posts } from "#/lib/content";

/**
 * XML sitemap, served as an explicit route rather than a generated static file.
 *
 * The build-time sitemap plugin writes /sitemap.xml into the client output, but a single-segment
 * file isn't in nitro's static-asset manifest, so the `$user` catch-all shadows it and the URL
 * renders a bogus "sitemap.xml's commit history" page. An explicit route outranks `$user` (same
 * as robots[.]txt.tsx), so this always wins. It's generated from the content collections, so new
 * editorial pages appear automatically.
 *
 * Editorial pages only — never the DB-backed `$user`/org lookup routes.
 */
const SITE = "https://commit-history.com";

interface SitemapEntry {
	path: string;
	changefreq: string;
	priority: string;
	lastmod?: string;
}

function renderSitemap(): string {
	// Server route, so a real clock is available (unlike build-time); the homepage is DB-driven
	// and effectively always fresh, so it gets today's date.
	const today = new Date().toISOString().slice(0, 10);
	const entries: SitemapEntry[] = [
		{ path: "/", changefreq: "weekly", priority: "1.0", lastmod: today },
		{ path: "/-/metrics", changefreq: "monthly", priority: "0.8" },
		{ path: "/-/sponsoring", changefreq: "monthly", priority: "0.5" },
		...articles.map((a) => ({
			path: `/-/metrics/${a.slug}`,
			changefreq: "monthly",
			priority: "0.7",
			lastmod: a.updatedAt,
		})),
		...orgArticles.map((a) => ({
			path: `/-/organizations/${a.slug}`,
			changefreq: "monthly",
			priority: "0.7",
			lastmod: a.updatedAt,
		})),
		...posts.map((a) => ({
			path: `/-/${a.slug}`,
			changefreq: "weekly",
			priority: "0.8",
			lastmod: a.updatedAt,
		})),
	];
	const urls = entries
		.map((e) =>
			[
				"  <url>",
				`    <loc>${SITE}${e.path}</loc>`,
				e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : "",
				`    <changefreq>${e.changefreq}</changefreq>`,
				`    <priority>${e.priority}</priority>`,
				"  </url>",
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export const Route = createFileRoute("/sitemap.xml")({
	server: {
		handlers: {
			GET: () =>
				new Response(renderSitemap(), {
					headers: {
						"content-type": "application/xml; charset=utf-8",
						"cache-control": "public, max-age=3600",
					},
				}),
		},
	},
});
