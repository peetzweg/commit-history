import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import mdx from "@mdx-js/rollup";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import { defineConfig } from "vite";

// Static MDX articles: every src/content/<collection>/<slug>.mdx becomes /-/<collection>/<slug>.
// Listed here so the build prerenders them to plain HTML (no SSR invocation per crawl —
// see #70's cost concern) and emits them into the generated sitemap.
function contentSlugs(collection: string): string[] {
	return readdirSync(
		fileURLToPath(new URL(`./src/content/${collection}`, import.meta.url)),
	)
		.filter((f) => f.endsWith(".mdx"))
		.map((f) => f.replace(/\.mdx$/, ""));
}
const metricSlugs = contentSlugs("metrics");
const orgSlugs = contentSlugs("organizations");
const postSlugs = contentSlugs("posts");

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	// @resvg/resvg-js is a native Node addon (.node binary). The dev-mode dependency
	// optimizer scans it via the OG route's imports and crashes trying to parse the
	// binary as JS (UNLOADABLE_DEPENDENCY). It only ever runs in server handlers, so
	// keep it out of prebundling; prod builds were never affected (handlers are
	// tree-shaken out of the client there).
	optimizeDeps: { exclude: ["@resvg/resvg-js"] },
	plugins: [
		devtools(),
		tailwindcss(),
		// MDX must transform before React; frontmatter is exported for head()/listings.
		{
			enforce: "pre",
			...mdx({
				remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkGfm],
				rehypePlugins: [rehypeSlug],
			}),
		},
		tanstackStart({
			// Generated into the client output as /sitemap.xml (replaces the old static file;
			// robots.txt already points there). Only pages listed below are included — the
			// dynamic per-user sitemap (#70) will join as a sitemap index later.
			sitemap: { host: "https://commit-history.com" },
			// Only the explicit list below — never crawl into DB-backed routes.
			prerender: { autoStaticPathsDiscovery: false },
			pages: [
				// Homepage is DB-driven — sitemap entry only, never prerendered.
				{
					path: "/",
					prerender: { enabled: false },
					sitemap: { changefreq: "weekly", priority: 1.0 },
				},
				// `enabled: true` must be explicit — it's what switches prerendering on for
				// the whole build (a page relying on the schema default doesn't). And
				// `crawlLinks` (default true) must be off, or in-article links to live pages
				// (e.g. /torvalds,gaearon) get baked into stale static HTML at build time.
				//
				// All editorial content lives under the reserved /-/ namespace: "-" can never
				// be a GitHub login (no leading/trailing hyphens), so nothing here can shadow
				// the single-segment $user route — and inside the namespace sections may own
				// their bare prefix, so the metrics hub is /-/metrics directly. Old URLs
				// (/sponsoring, /metrics/*, /organizations/*) 301 via thin redirect routes
				// and are deliberately absent from this list.
				{
					path: "/-/metrics",
					prerender: { enabled: true, crawlLinks: false },
					sitemap: { changefreq: "monthly", priority: 0.8 },
				},
				// The sponsor pitch page — static content, so prerendered like the explainers.
				{
					path: "/-/sponsoring",
					prerender: { enabled: true, crawlLinks: false },
					sitemap: { changefreq: "monthly", priority: 0.5 },
				},
				...metricSlugs.map((slug) => ({
					path: `/-/metrics/${slug}`,
					prerender: { enabled: true, crawlLinks: false },
					sitemap: { changefreq: "monthly" as const, priority: 0.7 },
				})),
				// Organization-context explainers.
				...orgSlugs.map((slug) => ({
					path: `/-/organizations/${slug}`,
					prerender: { enabled: true, crawlLinks: false },
					sitemap: { changefreq: "monthly" as const, priority: 0.7 },
				})),
				// Standalone posts, flat under /-/ (leaderboard rankings etc). Refreshed in place,
				// so weekly signals crawlers to revisit as the underlying boards move.
				...postSlugs.map((slug) => ({
					path: `/-/${slug}`,
					prerender: { enabled: true, crawlLinks: false },
					sitemap: { changefreq: "weekly" as const, priority: 0.8 },
				})),
			],
		}),
		nitro(),
		viteReact(),
	],
});

export default config;
