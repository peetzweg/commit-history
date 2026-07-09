/**
 * Build-time Open Graph card generation for the static pages.
 *
 * Two families, both rendered from the shared card builders in src/lib/og-card.ts (satori →
 * resvg, in the site's hand-drawn xkcd/star-history style):
 *   • /metrics/<slug> + the /metrics/explained hub → public/og/metrics/<slug>.png
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
import { boardCard, metricsCard, renderPng } from "#/lib/og-card";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = join(root, "src/content/metrics");
const metricsOutDir = join(root, "public/og/metrics");
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
	const png = await renderPng(metricsCard(title, description));
	write(join(metricsOutDir, `${slug}.png`), png, `metrics/${slug}.png`);
}

interface Frontmatter {
	title: string;
	description: string;
}

function frontmatterOf(file: string): Frontmatter {
	const source = readFileSync(join(contentDir, file), "utf8");
	const match = source.match(/^---\n([\s\S]*?)\n---/);
	if (!match) throw new Error(`${file}: missing frontmatter`);
	const fm = parse(match[1]) as Partial<Frontmatter>;
	if (!fm.title || !fm.description) {
		throw new Error(`${file}: frontmatter needs title + description`);
	}
	return { title: fm.title, description: fm.description };
}

mkdirSync(metricsOutDir, { recursive: true });
mkdirSync(boardOutDir, { recursive: true });

// The /metrics/explained hub itself — keep in sync with src/routes/metrics.explained.tsx.
await renderMetricsCard(
	"explained",
	"GitHub contribution metrics, explained",
	"What the numbers on a commit-history.com profile actually mean: commits, pull requests, reviews, repositories, and private contributions.",
);

for (const file of readdirSync(contentDir)) {
	if (!file.endsWith(".mdx")) continue;
	const { title, description } = frontmatterOf(file);
	await renderMetricsCard(file.replace(/\.mdx$/, ""), title, description);
}

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
