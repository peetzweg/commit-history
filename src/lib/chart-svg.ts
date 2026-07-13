import { pickYearTicks } from "#/lib/chart-ticks";
import {
	CROWN_ASPECT,
	CROWN_FILL,
	CROWN_PATH,
	CROWN_TRANSFORM,
	CROWN_VIEWBOX,
} from "#/lib/crown";
import type { CommitHistory } from "#/lib/github";
import { xkcdFontDataUrl } from "#/lib/xkcd-font";

/**
 * Standalone SVG-string renderer for the embeddable chart (`/embed/$user`).
 *
 * Unlike the React <CommitChart>, this returns a self-contained SVG string: the xkcd font is
 * inlined as base64 and the hand-drawn "xkcdify" filter is included, so it renders identically
 * inside a GitHub README (where the <img> sandbox blocks external fonts/scripts). A homage to
 * star-history.com's embed.
 */

const ACCENT = "#16a34a";
const W = 800;
const H = 400;
const PAD = { top: 52, right: 24, bottom: 38, left: 64 };
const innerW = W - PAD.left - PAD.right;
const innerH = H - PAD.top - PAD.bottom;

type Theme = "light" | "dark";

interface ThemeColors {
	bg: string;
	fg: string;
	muted: string;
	grid: string;
}

// `bg` is matched to GitHub's own README surface color so the embed blends in
// (no border/card) on both light and dark profiles.
const THEMES: Record<Theme, ThemeColors> = {
	light: { bg: "#ffffff", fg: "#363636", muted: "#6b7280", grid: "#e5e7eb" },
	dark: { bg: "#0d1117", fg: "#c9d1d9", muted: "#8b949e", grid: "#30363d" },
};

// The data type a chart shows. "all" is the aggregate (public commits + private contributions —
// what the embed sums today); "commits" is live too, the rest are on the roadmap. Each gets its
// embed wording here — the single switch point for new types. Per-type ranking on the embed is
// tracked separately (see the "rank on the embed" issue).
export type GraphType =
	| "all"
	| "commits"
	| "pullRequests"
	| "issues"
	| "reviews"
	| "repositories";

// The embed is standalone (no profile header like the on-page chart), so `title(login)` always
// leads with the username; `unit` labels the running total.
const TYPE_WORDS: Record<
	GraphType,
	{ title: (login: string) => string; unit: string }
> = {
	all: {
		title: (l) => `all of ${l}'s GitHub contributions`,
		unit: "contributions",
	},
	commits: { title: (l) => `${l}'s commits`, unit: "commits" },
	pullRequests: { title: (l) => `${l}'s pull requests`, unit: "pull requests" },
	issues: { title: (l) => `${l}'s issues`, unit: "issues" },
	reviews: { title: (l) => `${l}'s reviews`, unit: "reviews" },
	repositories: { title: (l) => `${l}'s repositories`, unit: "repositories" },
};

function compact(n: number) {
	return new Intl.NumberFormat("en-US", { notation: "compact" }).format(n);
}

function esc(s: string) {
	return s.replace(/[<>&"']/g, (c) =>
		c === "<"
			? "&lt;"
			: c === ">"
				? "&gt;"
				: c === "&"
					? "&amp;"
					: c === '"'
						? "&quot;"
						: "&#39;",
	);
}

// The bottom-right crown + "commit-history.com" credit — the crown logo (public/crown.svg via
// lib/crown) in a nested <svg>, snug to the left of the wordmark near the plot's right edge.
// Mirrors the React <ChartAttribution> so the embed and live charts match.
function credit(color: string): string {
	const font = 13;
	const text = "commit-history.com";
	const y = H - 8;
	// Small crown, snug to the wordmark, vertically centred on it (see <ChartAttribution>).
	const crownH = font * 0.78;
	const crownW = crownH * CROWN_ASPECT;
	const gap = font * 0.22;
	const textW = text.length * 0.56 * font;
	const rightEdge = W - PAD.right;
	const startX = rightEdge - textW - gap - crownW;
	const crownY = y - font * 0.25 - crownH / 2;
	// Text left-anchored right after the crown so the gap between them is exact (see ChartAttribution).
	return (
		`<svg x="${startX.toFixed(1)}" y="${crownY.toFixed(1)}" width="${crownW.toFixed(1)}" height="${crownH.toFixed(1)}" viewBox="${CROWN_VIEWBOX}" aria-hidden="true"><g transform="${CROWN_TRANSFORM}"><path fill="${CROWN_FILL}" d="${CROWN_PATH}"/></g></svg>` +
		`<text x="${(startX + crownW + gap).toFixed(1)}" y="${y}" font-size="${font}" fill="${color}">${text}</text>`
	);
}

function shell(theme: Theme, body: string) {
	const c = THEMES[theme];
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="xkcd, 'Comic Sans MS', cursive">
<defs>
<style>@font-face{font-family:"xkcd";src:url(${xkcdFontDataUrl}) format("truetype");}</style>
<linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.18"/>
<stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
</linearGradient>
<filter id="xkcdify" filterUnits="userSpaceOnUse" x="-5" y="-5" width="100%" height="100%">
<feTurbulence type="fractalNoise" baseFrequency="0.05" result="noise"/>
<feDisplacementMap scale="4" xChannelSelector="R" yChannelSelector="G" in="SourceGraphic" in2="noise"/>
</filter>
</defs>
<rect width="${W}" height="${H}" fill="${c.bg}"/>
${body}
</svg>`;
}

export function renderChartSvg(
	history: CommitHistory,
	theme: Theme = "light",
	type: GraphType = "all",
): string {
	const c = THEMES[theme];
	const { points, total, totalRestricted, user } = history;
	if (points.length === 0) {
		return renderMessageSvg(`${user.login} has no public commits`, theme);
	}

	// Default to "both": public commits + private contributions, summed per month —
	// the same series the main chart shows. For users who don't expose private
	// activity, `restrictedCumulative` is 0, so this is identical to public.
	const value = (p: (typeof points)[number]) =>
		p.cumulative + p.restrictedCumulative;
	const grandTotal = total + totalRestricted;

	const n = points.length;
	const max = Math.max(...points.map(value), 1);
	const x = (i: number) =>
		PAD.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
	const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
	const baseline = PAD.top + innerH;

	const line = points
		.map(
			(p, i) =>
				`${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(value(p)).toFixed(1)}`,
		)
		.join(" ");
	const area = `${line} L${x(n - 1).toFixed(1)},${baseline} L${x(0).toFixed(1)},${baseline} Z`;

	const yTicks = Array.from({ length: 5 }, (_, i) => Math.round((max / 4) * i));
	const yearTicks = points
		.map((p, i) => ({ i, year: p.date.slice(0, 4) }))
		.filter((t, idx, arr) => idx === 0 || t.year !== arr[idx - 1].year);
	// Axis labels use font-size 14 below; thin the year row to that so it never crowds.
	const xTicks = pickYearTicks(yearTicks, innerW, 14);
	const dotEvery = Math.max(1, Math.ceil(n / 60));

	const gridY = yTicks
		.map(
			(v) =>
				`<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${c.grid}" filter="url(#xkcdify)"/>` +
				`<text x="${PAD.left - 10}" y="${y(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="${c.muted}" font-size="14">${compact(v)}</text>`,
		)
		.join("");
	const labelsX = xTicks
		.map(
			(t) =>
				`<text x="${x(t.i).toFixed(1)}" y="${H - 26}" text-anchor="middle" fill="${c.muted}" font-size="14">${t.year}</text>`,
		)
		.join("");
	const dots = points
		.map((p, i) =>
			i % dotEvery === 0 || i === n - 1
				? `<circle cx="${x(i).toFixed(1)}" cy="${y(value(p)).toFixed(1)}" r="2.5" fill="${ACCENT}"/>`
				: "",
		)
		.join("");

	const words = TYPE_WORDS[type];
	const title = esc(words.title(user.login));
	const countUnit = words.unit;

	const body = `
<text x="${PAD.left}" y="30" font-size="22" fill="${c.fg}">${title}</text>
<text x="${W - PAD.right}" y="30" text-anchor="end" font-size="15" fill="${c.muted}">${grandTotal.toLocaleString()} ${countUnit}</text>
${gridY}
${labelsX}
<g filter="url(#xkcdify)">
<path d="${area}" fill="url(#fill)"/>
<path d="${line}" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/>
${dots}
</g>
${credit(c.muted)}`;

	return shell(theme, body);
}

/** A centered message card (errors, empty state) — keeps the embed from showing a broken image. */
export function renderMessageSvg(
	message: string,
	theme: Theme = "light",
): string {
	const c = THEMES[theme];
	const body = `<text x="${W / 2}" y="${H / 2 - 8}" text-anchor="middle" font-size="22" fill="${c.fg}">Commit History</text>
<text x="${W / 2}" y="${H / 2 + 24}" text-anchor="middle" font-size="16" fill="${c.muted}">${esc(message)}</text>`;
	return shell(theme, body);
}
