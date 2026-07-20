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
			// Prerender config only. The sitemap is NOT generated here: a single-segment file
			// like /sitemap.xml written into the client output isn't in nitro's static-asset
			// manifest, so the `$user` catch-all shadows it at runtime. It's served instead by
			// an explicit route (src/routes/sitemap[.]xml.tsx), the same trick robots.txt uses.
			prerender: { autoStaticPathsDiscovery: false },
			pages: [
				// Homepage is DB-driven — never prerendered (and listed in the sitemap route).
				{
					path: "/",
					prerender: { enabled: false },
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
				},
				// The sponsor pitch page — static content, so prerendered like the explainers.
				{
					path: "/-/sponsoring",
					prerender: { enabled: true, crawlLinks: false },
				},
				...metricSlugs.map((slug) => ({
					path: `/-/metrics/${slug}`,
					prerender: { enabled: true, crawlLinks: false },
				})),
				// Organization-context explainers.
				...orgSlugs.map((slug) => ({
					path: `/-/organizations/${slug}`,
					prerender: { enabled: true, crawlLinks: false },
				})),
				// Standalone posts, flat under /-/ (leaderboard rankings etc).
				...postSlugs.map((slug) => ({
					path: `/-/${slug}`,
					prerender: { enabled: true, crawlLinks: false },
				})),
			],
		}),
		nitro(),
		viteReact(),
	],
});

export default config;
