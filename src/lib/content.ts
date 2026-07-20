/**
 * The MDX content collections (all under the reserved /-/ namespace — "-" can never be a
 * GitHub login, so editorial pages never shadow the $user route):
 * - src/content/metrics/<slug>.mdx → /-/metrics/<slug> (individual metrics, /-/metrics hub)
 * - src/content/organizations/<slug>.mdx → /-/organizations/<slug> (organization context —
 *   deliberately its own collection, NOT mixed into the individuals' hub: the definitions differ,
 *   e.g. org-scoped vs global contributions)
 * - src/content/posts/<slug>.mdx → /-/<slug> (standalone long-form pieces, e.g. leaderboard
 *   rankings — flat under /-/ so each gets a clean article slug with no section prefix;
 *   time-sensitive ones carry a visible updatedAt)
 *
 * Two globs per collection with different costs:
 * - an eager, frontmatter-only glob (tiny — just the exported metadata objects), used
 *   synchronously by route `head()`s and the /metrics index, and
 * - a lazy component glob, so each article's compiled body is its own code-split chunk
 *   loaded only on its page.
 *
 * Adding an article = dropping an .mdx file into its collection directory. The vite config
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
	/** Position in the /-/metrics hub list (unset sorts last, then by title). */
	order?: number;
	/**
	 * Ranked-list posts only: the entities in ranking order. Emitted as ItemList structured
	 * data so search engines and agents can read the ranking without parsing prose. Mirror the
	 * `<Person>` blocks in the body (same order); each `login` links to that profile on-site.
	 */
	people?: { login: string; name: string }[];
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

/** All articles in curated reading order — for the /-/metrics hub. */
export const articles: ArticleMeta[] = Object.entries(frontmatters)
	.map(([path, fm]) => ({ slug: slugOf(path), ...fm }))
	.sort(
		(a, b) =>
			(a.order ?? Number.MAX_SAFE_INTEGER) -
				(b.order ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title),
	);

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

// ── Organization collection (/-/organizations/<slug>) ────────────────────────

const orgFrontmatters = import.meta.glob<ArticleFrontmatter>(
	"../content/organizations/*.mdx",
	{ eager: true, import: "frontmatter" },
);

const orgComponents = import.meta.glob<{ default: MDXContent }>(
	"../content/organizations/*.mdx",
);

/** All organization articles in curated reading order. */
export const orgArticles: ArticleMeta[] = Object.entries(orgFrontmatters)
	.map(([path, fm]) => ({ slug: slugOf(path), ...fm }))
	.sort(
		(a, b) =>
			(a.order ?? Number.MAX_SAFE_INTEGER) -
				(b.order ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title),
	);

export function getOrgArticleMeta(slug: string): ArticleMeta | undefined {
	return orgArticles.find((a) => a.slug === slug);
}

/** Lazily import an organization article's compiled MDX module (shape fits React.lazy). */
export function loadOrgArticle(
	slug: string,
): Promise<{ default: MDXContent }> | undefined {
	const load = orgComponents[`../content/organizations/${slug}.mdx`];
	return load?.();
}

// ── Standalone posts collection (/-/<slug>) ──────────────────────────────────

const postFrontmatters = import.meta.glob<ArticleFrontmatter>(
	"../content/posts/*.mdx",
	{ eager: true, import: "frontmatter" },
);

const postComponents = import.meta.glob<{ default: MDXContent }>(
	"../content/posts/*.mdx",
);

/** All standalone posts in curated reading order. */
export const posts: ArticleMeta[] = Object.entries(postFrontmatters)
	.map(([path, fm]) => ({ slug: slugOf(path), ...fm }))
	.sort(
		(a, b) =>
			(a.order ?? Number.MAX_SAFE_INTEGER) -
				(b.order ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title),
	);

export function getPostMeta(slug: string): ArticleMeta | undefined {
	return posts.find((a) => a.slug === slug);
}

/** Lazily import a post's compiled MDX module (shape fits React.lazy). */
export function loadPost(
	slug: string,
): Promise<{ default: MDXContent }> | undefined {
	const load = postComponents[`../content/posts/${slug}.mdx`];
	return load?.();
}
