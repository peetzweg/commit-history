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
	const xTicks = points
		.map((p, i) => ({ i, year: p.date.slice(0, 4) }))
		.filter((t, idx, arr) => idx === 0 || t.year !== arr[idx - 1].year);
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

	const title = esc(`${user.login}'s commit history`);

	const body = `
<text x="${PAD.left}" y="30" font-size="22" fill="${c.fg}">${title}</text>
<text x="${W - PAD.right}" y="30" text-anchor="end" font-size="15" fill="${c.muted}">${grandTotal.toLocaleString()} commits</text>
${gridY}
${labelsX}
<g filter="url(#xkcdify)">
<path d="${area}" fill="url(#fill)"/>
<path d="${line}" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/>
${dots}
</g>
<text x="${PAD.left}" y="${H - 8}" font-size="13" fill="${c.muted}"><tspan font-size="15">📈</tspan> commit-history.com</text>`;

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
