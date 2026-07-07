/**
 * Build-time Open Graph card generation for the /metrics content pages.
 *
 * For every src/content/metrics/<slug>.mdx (plus a hardcoded entry for the /metrics hub)
 * this renders a 1200×630 PNG from the frontmatter title/description into
 * public/og/metrics/<slug>.png, in the site's hand-drawn chart style (xkcd font,
 * star-history palette). Runs before `vite build` (see package.json) so the images ship
 * as plain static assets — no runtime rendering, no function invocations.
 *
 *   node scripts/generate-og.ts      # also: pnpm og
 *
 * Deterministic: same frontmatter in → same pixels out. public/og/ is gitignored.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = join(root, "src/content/metrics");
const outDir = join(root, "public/og/metrics");

// ── Palette: mirrors src/styles.css (star-history homage) ────────────────────
const FG = "#363636";
const MUTED = "#71717a";
const ACCENT = "#16a34a";

const xkcdFont = readFileSync(join(root, "public/fonts/xkcd.ttf"));
const crownSvg = readFileSync(join(root, "public/crown.svg"), "utf8");
const crownDataUrl = `data:image/svg+xml;base64,${Buffer.from(crownSvg).toString("base64")}`;

/** The xkcd font covers basic latin only — fold typographic characters down to ASCII. */
function asciiFold(text: string): string {
	return text
		.replaceAll(/[“”]/g, '"')
		.replaceAll(/[‘’]/g, "'")
		.replaceAll(/[—–]/g, "-")
		.replaceAll("…", "...");
}

// A gently rising, hand-drawn-ish cumulative curve — the site's visual signature —
// tucked behind the text in the accent green.
const curveSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="320" viewBox="0 0 560 320">
  <path d="M 8 304 C 120 300, 180 288, 240 258 C 300 228, 330 190, 390 138 C 450 86, 500 48, 552 16"
    fill="none" stroke="${ACCENT}" stroke-width="7" stroke-linecap="round" opacity="0.22"/>
</svg>`;
const curveDataUrl = `data:image/svg+xml;base64,${Buffer.from(curveSvg).toString("base64")}`;

// ── Minimal element factory (satori accepts React-shaped plain objects) ──────
type Child = Node | string;
interface Node {
	type: string;
	props: Record<string, unknown>;
}
function el(
	type: string,
	props: Record<string, unknown>,
	...children: Child[]
): Node {
	if (children.length > 0) {
		props = {
			...props,
			children: children.length === 1 ? children[0] : children,
		};
	}
	return { type, props };
}

function card(title: string, description: string): Node {
	return el(
		"div",
		{
			style: {
				width: 1200,
				height: 630,
				display: "flex",
				flexDirection: "column",
				backgroundColor: "#ffffff",
				padding: 72,
				fontFamily: "xkcd",
				position: "relative",
			},
		},
		// Background curve, bottom-right.
		el("img", {
			src: curveDataUrl,
			width: 560,
			height: 320,
			style: { position: "absolute", right: 48, bottom: 40 },
		}),
		// Header: crown + site name.
		el(
			"div",
			{ style: { display: "flex", alignItems: "center", gap: 20 } },
			el("img", { src: crownDataUrl, width: 52, height: 46 }),
			el(
				"div",
				{ style: { display: "flex", fontSize: 32, color: FG } },
				"commit-history.com",
			),
			el(
				"div",
				{ style: { display: "flex", fontSize: 32, color: MUTED } },
				"/ metrics, explained",
			),
		),
		// Title + description, pushed toward the vertical center.
		el(
			"div",
			{
				style: {
					display: "flex",
					flexDirection: "column",
					marginTop: "auto",
					marginBottom: "auto",
					maxWidth: 980,
				},
			},
			el(
				"div",
				{
					style: {
						display: "flex",
						fontSize: 68,
						lineHeight: 1.15,
						color: FG,
					},
				},
				asciiFold(title),
			),
			el(
				"div",
				{
					style: {
						display: "flex",
						marginTop: 28,
						fontSize: 30,
						lineHeight: 1.4,
						color: MUTED,
						maxWidth: 860,
					},
				},
				asciiFold(description),
			),
		),
		// Accent baseline, like the chart axis.
		el("div", {
			style: {
				display: "flex",
				width: 260,
				height: 7,
				borderRadius: 4,
				backgroundColor: ACCENT,
			},
		}),
	);
}

async function renderCard(slug: string, title: string, description: string) {
	const svg = await satori(
		card(title, description) as unknown as Parameters<typeof satori>[0],
		{
			width: 1200,
			height: 630,
			fonts: [{ name: "xkcd", data: xkcdFont, weight: 400, style: "normal" }],
		},
	);
	const png = new Resvg(svg).render().asPng();
	writeFileSync(join(outDir, `${slug}.png`), png);
	console.log(`og: metrics/${slug}.png (${(png.length / 1024).toFixed(0)}kB)`);
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

mkdirSync(outDir, { recursive: true });

// The /metrics hub itself — keep in sync with src/routes/metrics.index.tsx.
await renderCard(
	"index",
	"GitHub contribution metrics, explained",
	"What the numbers on a commit-history.com profile actually mean: commits, pull requests, reviews, repositories, and private contributions.",
);

for (const file of readdirSync(contentDir)) {
	if (!file.endsWith(".mdx")) continue;
	const { title, description } = frontmatterOf(file);
	await renderCard(file.replace(/\.mdx$/, ""), title, description);
}
