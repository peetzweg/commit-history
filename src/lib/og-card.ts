/**
 * Shared Open Graph card rendering — the satori + resvg building blocks behind every
 * 1200×630 share image, in the site's hand-drawn (xkcd font, star-history palette) style.
 *
 * Two consumers, one look:
 *   • scripts/generate-og.ts (build time) — the /metrics cards and the two leaderboard cards.
 *   • src/routes/og.$kind.$login.tsx (runtime) — per-developer / per-org cards.
 *
 * Deliberately fs-free: the font comes from the inlined `xkcdFontDataUrl` and the crown is
 * rebuilt from lib/crown constants, so this module runs unchanged inside the server bundle
 * (Netlify function / Coolify node output) where public/ assets aren't readable.
 */
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import {
	CROWN_ASPECT,
	CROWN_FILL,
	CROWN_PATH,
	CROWN_TRANSFORM,
	CROWN_VIEWBOX,
} from "#/lib/crown";
import { xkcdFontDataUrl } from "#/lib/xkcd-font";

// ── Palette: mirrors src/styles.css (star-history homage) ────────────────────
const FG = "#363636";
const MUTED = "#71717a";
const ACCENT = "#16a34a";
const CARD_BG = "#ffffff";

// The xkcd font, decoded from its data URL — no filesystem read, so it works at runtime.
const xkcdFont = Buffer.from(xkcdFontDataUrl.split(",")[1], "base64");

// The crown logo, rebuilt from the shared path constants (same mark as ChartAttribution),
// as a standalone SVG data URL satori can drop into an <img>.
const crownSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${CROWN_VIEWBOX}"><g transform="${CROWN_TRANSFORM}"><path fill="${CROWN_FILL}" d="${CROWN_PATH}"/></g></svg>`;
const crownDataUrl = `data:image/svg+xml;base64,${Buffer.from(crownSvg).toString("base64")}`;

// A gently rising, hand-drawn-ish cumulative curve — the site's visual signature —
// tucked behind the text in the accent green.
const curveSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="320" viewBox="0 0 560 320">
  <path d="M 8 304 C 120 300, 180 288, 240 258 C 300 228, 330 190, 390 138 C 450 86, 500 48, 552 16"
    fill="none" stroke="${ACCENT}" stroke-width="7" stroke-linecap="round" opacity="0.22"/>
</svg>`;
const curveDataUrl = `data:image/svg+xml;base64,${Buffer.from(curveSvg).toString("base64")}`;

/** The xkcd font covers basic latin only — fold typographic characters down to ASCII. */
export function asciiFold(text: string): string {
	return text
		.replaceAll(/[“”]/g, '"')
		.replaceAll(/[‘’]/g, "'")
		.replaceAll(/[—–]/g, "-")
		.replaceAll("…", "...");
}

/**
 * A display name we can actually render, or null. The xkcd font is ASCII-only, so a name with
 * out-of-range glyphs (accented / CJK) would print as tofu — in that case we fall back to the
 * login (always ASCII per GitHub's rules), handled by the callers.
 */
function renderableName(name: string | null | undefined): string | null {
	const candidate = name?.trim();
	if (!candidate) return null;
	const folded = asciiFold(candidate);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII-range guard.
	return /^[\x00-\x7F]+$/.test(folded) ? folded : null;
}

// ── Minimal element factory (satori accepts React-shaped plain objects) ──────
export type Child = OgNode | string;
export interface OgNode {
	type: string;
	props: Record<string, unknown>;
}
export function el(
	type: string,
	props: Record<string, unknown>,
	...children: Child[]
): OgNode {
	if (children.length > 0) {
		props = {
			...props,
			children: children.length === 1 ? children[0] : children,
		};
	}
	return { type, props };
}

/** Crown + "commit-history.com" wordmark, sized to `fontSize`. The site's signature lockup. */
function wordmark(fontSize: number): OgNode {
	const crownH = Math.round(fontSize * 1.05);
	const crownW = Math.round(crownH * CROWN_ASPECT);
	return el(
		"div",
		{ style: { display: "flex", alignItems: "center", gap: 14 } },
		el("img", { src: crownDataUrl, width: crownW, height: crownH }),
		el(
			"div",
			{ style: { display: "flex", fontSize, color: FG } },
			"commit-history.com",
		),
	);
}

/** The outer 1200×630 frame every card shares. */
function frame(...children: Child[]): OgNode {
	return el(
		"div",
		{
			style: {
				width: 1200,
				height: 630,
				display: "flex",
				flexDirection: "column",
				backgroundColor: CARD_BG,
				padding: 72,
				fontFamily: "xkcd",
				position: "relative",
			},
		},
		el("img", {
			src: curveDataUrl,
			width: 560,
			height: 320,
			style: { position: "absolute", right: 48, bottom: 40 },
		}),
		...children,
	);
}

/** Circular (user) or rounded-square (org) avatar, or a monogram placeholder when missing. */
function avatarBlock(
	avatarDataUrl: string | null,
	login: string,
	shape: "circle" | "square",
): OgNode {
	const size = 200;
	const radius = shape === "circle" ? size / 2 : 36;
	if (avatarDataUrl) {
		return el("img", {
			src: avatarDataUrl,
			width: size,
			height: size,
			style: { borderRadius: radius, objectFit: "cover" },
		});
	}
	return el(
		"div",
		{
			style: {
				display: "flex",
				width: size,
				height: size,
				borderRadius: radius,
				backgroundColor: "#e4e4e7",
				alignItems: "center",
				justifyContent: "center",
				fontSize: 96,
				color: MUTED,
			},
		},
		(login[0] ?? "?").toUpperCase(),
	);
}

/** name + @login header block, folding an unrenderable name down to the login. */
function identityBlock(name: string | null | undefined, login: string): OgNode {
	const display = renderableName(name);
	const heading = display ?? `@${login}`;
	const children: Child[] = [
		el(
			"div",
			{ style: { display: "flex", fontSize: 72, color: FG, lineHeight: 1.1 } },
			heading,
		),
	];
	if (display) {
		children.push(
			el(
				"div",
				{
					style: { display: "flex", fontSize: 34, color: MUTED, marginTop: 8 },
				},
				`@${login}`,
			),
		);
	}
	return el(
		"div",
		{ style: { display: "flex", flexDirection: "column" } },
		...children,
	);
}

/** The org card's single rank line, e.g. "#7 on the organization leaderboard". */
function rankLine(rank: number, label: string): OgNode {
	return el(
		"div",
		{ style: { display: "flex", alignItems: "baseline", gap: 16 } },
		el(
			"div",
			{ style: { display: "flex", fontSize: 56, color: FG } },
			`#${rank.toLocaleString("en-US")}`,
		),
		el(
			"div",
			{ style: { display: "flex", fontSize: 34, color: MUTED } },
			label,
		),
	);
}

/** The developer card's metric block: a big amount ("112,847 public commits") with the
 *  leaderboard place beneath it ("ranked #2"). Either line is omitted when its value is absent. */
function metricBlock(
	amount: { value: number; label: string } | null,
	rank: number | null,
): OgNode {
	const lines: Child[] = [];
	if (amount) {
		lines.push(
			el(
				"div",
				{ style: { display: "flex", alignItems: "baseline", gap: 14 } },
				el(
					"div",
					{ style: { display: "flex", fontSize: 60, color: FG } },
					amount.value.toLocaleString("en-US"),
				),
				el(
					"div",
					{ style: { display: "flex", fontSize: 34, color: MUTED } },
					amount.label,
				),
			),
		);
	}
	if (rank != null) {
		lines.push(
			el(
				"div",
				{
					style: { display: "flex", fontSize: 38, color: MUTED, marginTop: 10 },
				},
				`ranked #${rank.toLocaleString("en-US")}`,
			),
		);
	}
	return el(
		"div",
		{ style: { display: "flex", flexDirection: "column" } },
		...lines,
	);
}

// ── Public card builders ─────────────────────────────────────────────────────

export interface DeveloperCardInput {
	login: string;
	name: string | null;
	avatarDataUrl: string | null;
	/** The metric's amount, e.g. { value: 112847, label: "public commits" }. Null → hero line
	 *  omitted (the caller passes the metric the profile's ?metric= view is showing). */
	amount: { value: number; label: string } | null;
	/** Leaderboard place in that metric; null → the "ranked #N" line is omitted. */
	rank: number | null;
}

export function developerCard(input: DeveloperCardInput): OgNode {
	return frame(
		el(
			"div",
			{ style: { display: "flex", alignItems: "center", gap: 44 } },
			avatarBlock(input.avatarDataUrl, input.login, "circle"),
			identityBlock(input.name, input.login),
		),
		el(
			"div",
			{ style: { display: "flex", marginTop: "auto", marginBottom: 40 } },
			metricBlock(input.amount, input.rank),
		),
		wordmark(32),
	);
}

export interface OrgCardInput {
	login: string;
	name: string | null;
	avatarDataUrl: string | null;
	/** Current place on the organization leaderboard; null → line omitted. */
	place: number | null;
}

export function orgCard(input: OrgCardInput): OgNode {
	const ranks: Child[] = [];
	if (input.place != null) {
		ranks.push(rankLine(input.place, "on the organization leaderboard"));
	}
	return frame(
		el(
			"div",
			{ style: { display: "flex", alignItems: "center", gap: 44 } },
			avatarBlock(input.avatarDataUrl, input.login, "square"),
			identityBlock(input.name, input.login),
		),
		el(
			"div",
			{
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 18,
					marginTop: "auto",
					marginBottom: 40,
				},
			},
			...ranks,
		),
		wordmark(32),
	);
}

/** The static leaderboard cards — fixed content, chosen by `?kind` on the home route. */
export function boardCard(kind: "user" | "org"): OgNode {
	const title =
		kind === "org" ? "Organization leaderboard" : "Developer leaderboard";
	const subtitle =
		kind === "org"
			? "GitHub organizations ranked by their members' lifetime commits."
			: "GitHub developers ranked by their lifetime commits.";
	return frame(
		el(
			"div",
			{ style: { display: "flex", alignItems: "center", gap: 20 } },
			wordmark(32),
		),
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
					style: { display: "flex", fontSize: 84, lineHeight: 1.1, color: FG },
				},
				title,
			),
			el(
				"div",
				{
					style: {
						display: "flex",
						marginTop: 28,
						fontSize: 32,
						lineHeight: 1.4,
						color: MUTED,
						maxWidth: 860,
					},
				},
				subtitle,
			),
		),
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

/** The /metrics explainer card — title + description, matching the metrics hub style. */
export function metricsCard(title: string, description: string): OgNode {
	return frame(
		el(
			"div",
			{ style: { display: "flex", alignItems: "center", gap: 20 } },
			wordmark(32),
			el(
				"div",
				{ style: { display: "flex", fontSize: 32, color: MUTED } },
				"/ metrics, explained",
			),
		),
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
					style: { display: "flex", fontSize: 68, lineHeight: 1.15, color: FG },
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

/** Render a card node to a 1200×630 PNG. */
export async function renderPng(node: OgNode): Promise<Buffer> {
	const svg = await satori(node as unknown as Parameters<typeof satori>[0], {
		width: 1200,
		height: 630,
		fonts: [{ name: "xkcd", data: xkcdFont, weight: 400, style: "normal" }],
	});
	return Buffer.from(new Resvg(svg).render().asPng());
}
