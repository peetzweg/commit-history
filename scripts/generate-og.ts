/**
 * Build-time Open Graph card generation for the static pages.
 *
 * Two families, both rendered from the shared card builders in src/lib/og-card.ts (satori →
 * resvg, in the site's hand-drawn xkcd/star-history style):
 *   • /-/metrics/<slug> + the /-/metrics hub → public/og/metrics/<slug>.png (the asset
 *     directory keeps its historical og/metrics/ name — URLs and assets are decoupled)
 *   • the /-/sponsoring pitch page → public/og/sponsoring.png
 *   • the two leaderboard boards (developer / organization) → public/og/leaderboard/<board>.png
 *
 * Per-developer and per-org cards are NOT here — they're DB/GitHub-driven and rendered at
 * runtime by src/routes/og.$kind.$login.tsx (same builders).
 *
 * Runs before `vite build` (see package.json) so these ship as plain static assets — no runtime
 * rendering, no function invocations. Deterministic: same input in → same pixels out.
 * public/og/ is gitignored.
 *
 *   node scripts/generate-og.ts      # also: pnpm og
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { boardCard, contentCard, renderPng } from "#/lib/og-card";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = join(root, "src/content/metrics");
const postsContentDir = join(root, "src/content/posts");
const metricsOutDir = join(root, "public/og/metrics");
const postsOutDir = join(root, "public/og/posts");
const boardOutDir = join(root, "public/og/leaderboard");

function write(path: string, png: Buffer, label: string) {
	writeFileSync(path, png);
	console.log(`og: ${label} (${(png.length / 1024).toFixed(0)}kB)`);
}

async function renderMetricsCard(
	slug: string,
	title: string,
	description: string,
) {
	const png = await renderPng(contentCard("/ metrics, explained", title, description));
	write(join(metricsOutDir, `${slug}.png`), png, `metrics/${slug}.png`);
}

interface Frontmatter {
	title: string;
	description: string;
}

function frontmatterOf(dir: string, file: string): Frontmatter {
	const source = readFileSync(join(dir, file), "utf8");
	const match = source.match(/^---\n([\s\S]*?)\n---/);
	if (!match) throw new Error(`${file}: missing frontmatter`);
	const fm = parse(match[1]) as Partial<Frontmatter>;
	if (!fm.title || !fm.description) {
		throw new Error(`${file}: frontmatter needs title + description`);
	}
	return { title: fm.title, description: fm.description };
}

mkdirSync(metricsOutDir, { recursive: true });
mkdirSync(postsOutDir, { recursive: true });
mkdirSync(boardOutDir, { recursive: true });

// The /-/metrics hub itself — keep in sync with src/routes/[-].metrics.index.tsx.
// The card's asset name stays "explained.png" from the hub's old URL.
await renderMetricsCard(
	"explained",
	"GitHub contribution metrics, explained",
	"What the numbers on a commit-history.com profile actually mean: commits, pull requests, reviews, repositories, and private contributions.",
);

for (const file of readdirSync(contentDir)) {
	if (!file.endsWith(".mdx")) continue;
	const { title, description } = frontmatterOf(contentDir, file);
	await renderMetricsCard(file.replace(/\.mdx$/, ""), title, description);
}

// Standalone posts (/-/<slug>) — same card style; the kicker is just the site path.
for (const file of readdirSync(postsContentDir)) {
	if (!file.endsWith(".mdx")) continue;
	const { title, description } = frontmatterOf(postsContentDir, file);
	const slug = file.replace(/\.mdx$/, "");
	// No section kicker — these live flat at the site root, so the wordmark stands alone.
	const png = await renderPng(contentCard("", title, description));
	write(join(postsOutDir, `${slug}.png`), png, `posts/${slug}.png`);
}

// The /-/sponsoring pitch card — keep in sync with src/routes/[-].sponsoring.tsx.
write(
	join(root, "public/og/sponsoring.png"),
	await renderPng(
		contentCard(
			"/ sponsoring",
			"Sponsoring commit-history.com",
			"Put your product in front of a developer-first audience: 15k unique visitors and 57k page views in under a month, in a sponsor slot on both leaderboards.",
		),
	),
	"sponsoring.png",
);

// The two leaderboard share cards — fixed content, chosen by `?kind` in src/routes/index.tsx.
write(
	join(boardOutDir, "developer.png"),
	await renderPng(boardCard("user")),
	"leaderboard/developer.png",
);
write(
	join(boardOutDir, "org.png"),
	await renderPng(boardCard("org")),
	"leaderboard/org.png",
);
