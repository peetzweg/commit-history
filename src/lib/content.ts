/**
 * The MDX content collection: src/content/metrics/<slug>.mdx → /metrics/<slug>.
 *
 * Two globs over the same files with different costs:
 * - an eager, frontmatter-only glob (tiny — just the exported metadata objects), used
 *   synchronously by route `head()`s and the /metrics index, and
 * - a lazy component glob, so each article's compiled body is its own code-split chunk
 *   loaded only on its page.
 *
 * Adding an article = dropping an .mdx file into src/content/metrics/. The vite config
 * picks it up for prerender + sitemap; everything here picks it up via the globs.
 */
import type { MDXComponents } from "mdx/types";
import type { ComponentType } from "react";

export interface ArticleFrontmatter {
	title: string;
	description: string;
	/** ISO date strings ("2026-07-07") — kept as strings by the YAML core schema. */
	publishedAt: string;
	updatedAt: string;
}

type MDXContent = ComponentType<{ components?: MDXComponents }>;

const frontmatters = import.meta.glob<ArticleFrontmatter>(
	"../content/metrics/*.mdx",
	{ eager: true, import: "frontmatter" },
);

// Full module shape ({ default }) so the loader plugs straight into React.lazy.
const components = import.meta.glob<{ default: MDXContent }>(
	"../content/metrics/*.mdx",
);

function slugOf(path: string): string {
	// "../content/metrics/private-contributions.mdx" → "private-contributions"
	return path.replace(/^.*\/([^/]+)\.mdx$/, "$1");
}

export interface ArticleMeta extends ArticleFrontmatter {
	slug: string;
}

/** All articles, newest first — for the /metrics index and sitemap-ish listings. */
export const articles: ArticleMeta[] = Object.entries(frontmatters)
	.map(([path, fm]) => ({ slug: slugOf(path), ...fm }))
	.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

export function getArticleMeta(slug: string): ArticleMeta | undefined {
	return articles.find((a) => a.slug === slug);
}

/** Lazily import an article's compiled MDX module (shape fits React.lazy). */
export function loadArticle(
	slug: string,
): Promise<{ default: MDXContent }> | undefined {
	const load = components[`../content/metrics/${slug}.mdx`];
	return load?.();
}
