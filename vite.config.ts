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

// Static MDX articles: every src/content/<collection>/<slug>.mdx becomes /<collection>/<slug>.
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

const config = defineConfig({
	resolve: { tsconfigPaths: true },
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
				// The hub is /metrics/explained, NOT bare /metrics: content sections never
				// own their bare prefix, so single-segment paths keep falling through to
				// the $user route and no GitHub username is ever locked out.
				{
					path: "/metrics/explained",
					prerender: { enabled: true, crawlLinks: false },
					sitemap: { changefreq: "monthly", priority: 0.8 },
				},
				...metricSlugs.map((slug) => ({
					path: `/metrics/${slug}`,
					prerender: { enabled: true, crawlLinks: false },
					sitemap: { changefreq: "monthly" as const, priority: 0.7 },
				})),
				// Organization-context explainers — same policy (bare /organizations stays a login).
				...orgSlugs.map((slug) => ({
					path: `/organizations/${slug}`,
					prerender: { enabled: true, crawlLinks: false },
					sitemap: { changefreq: "monthly" as const, priority: 0.7 },
				})),
			],
		}),
		nitro(),
		viteReact(),
	],
});

export default config;
