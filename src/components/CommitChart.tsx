import { useState } from "react";
import { ChartAttribution } from "#/components/ChartAttribution";
import { ChartLegend } from "#/components/ChartLegend";
import { pickYearTicks } from "#/lib/chart-ticks";
import type { CommitPoint, InProgressMonth, MonthlyCount } from "#/lib/github";
import { useIsMobile } from "#/lib/useIsMobile";

// Fixed viewBox; the <svg> scales to its container via width:100%. Because labels are sized in
// viewBox units, they shrink with the container — so on a phone we swap to a layout with larger
// fonts and roomier padding (the desktop fonts are also nudged up a touch, since folks screenshot
// these to share). The /$user.svg embed renders its own SVG (lib/chart-svg.ts) and is unaffected.
const W = 880;
const H = 420;

// Bottom padding leaves two stacked rows under the plot: the x-axis year labels, then the
// "commit-history.com" credit line at the very bottom (matching MultiCommitChart).
const DESKTOP = {
	pad: { top: 48, right: 24, bottom: 54, left: 60 },
	font: { title: 24, axis: 16, readout: 16, legend: 16, footer: 13 },
};
const MOBILE = {
	pad: { top: 56, right: 16, bottom: 72, left: 88 },
	font: { title: 32, axis: 26, readout: 24, legend: 24, footer: 20 },
};

// star-history's brand green.
const ACCENT = "#16a34a";

function compact(n: number) {
	return new Intl.NumberFormat("en-US", { notation: "compact" }).format(n);
}

function monthLabel(date: string) {
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		year: "numeric",
	});
}

export type ChartMode =
	| "public"
	| "private"
	| "total"
	| "prs"
	| "issues"
	| "reviews"
	| "repos";

/** Hand-drawn graph heading for the metric on show — the one switch point for chart titles. */
export function chartTitle(mode: ChartMode): string {
	switch (mode) {
		case "private":
			return "Private Contributions";
		case "total":
			return "Total Contributions";
		case "prs":
			return "Pull Requests";
		case "issues":
			return "Issues";
		case "reviews":
			return "Reviews";
		case "repos":
			return "Repositories";
		default:
			return "Commit History";
	}
}

/** The metric phrase for the "<phrase> attributed by GitHub since <date>" caption. */
export function chartCaption(mode: ChartMode): string {
	switch (mode) {
		case "private":
			return "Cumulative private contributions";
		case "total":
			return "Cumulative total contributions";
		case "prs":
			return "Cumulative public pull requests";
		case "issues":
			return "Cumulative public issues";
		case "reviews":
			return "Cumulative public pull-request reviews";
		case "repos":
			// "created" + the forks note: GitHub only counts repositories the user created —
			// forks are excluded, so this figure is lower than the profile's repository count.
			return "Cumulative public repositories created (forks don’t count)";
		default:
			return "Cumulative public commits";
	}
}

/**
 * The month's raw count for the selected metric. "total" is every contribution type summed:
 * public commits + issues + PRs + reviews + repos, plus the opaque private (restricted) count —
 * all disjoint buckets, so nothing is double-counted.
 */
export function metricDelta(p: MonthlyCount, mode: ChartMode): number {
	switch (mode) {
		case "public":
			return p.commits;
		case "private":
			return p.restricted;
		case "total":
			return (
				p.commits +
				p.issues +
				p.pullRequests +
				p.reviews +
				p.repos +
				p.restricted
			);
		case "prs":
			return p.pullRequests;
		case "issues":
			return p.issues;
		case "reviews":
			return p.reviews;
		case "repos":
			return p.repos;
	}
}

/**
 * Running cumulative series for the selected metric. For commits/private/both this reproduces the
 * precomputed `cumulative`/`restrictedCumulative`; the other types have no stored cumulative, so we
 * accumulate their per-month counts here.
 */
export function cumulativeSeries(
	points: CommitPoint[],
	mode: ChartMode,
): number[] {
	let sum = 0;
	return points.map((p) => {
		sum += metricDelta(p, mode);
		return sum;
	});
}

export function CommitChart({
	points,
	inProgress = null,
	mode = "public",
	label,
	title = chartTitle(mode),
}: {
	points: CommitPoint[];
	/** Current month so far plus its projection, drawn dashed past the last completed month. */
	inProgress?: InProgressMonth | null;
	mode?: ChartMode;
	/** Username shown in the in-chart legend (omit to hide the legend). */
	label?: string;
	/** Hand-drawn heading; defaults to the metric's title (see chartTitle). */
	title?: string;
}) {
	const [hover, setHover] = useState<number | null>(null);
	const isMobile = useIsMobile();
	const { pad: PAD, font: FONT } = isMobile ? MOBILE : DESKTOP;
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;
	if (points.length === 0) return null;

	// Cumulative value to plot (per point, by index) and the month's delta, for the selected metric.
	const cum = cumulativeSeries(points, mode);
	const dval = (p: CommitPoint) => metricDelta(p, mode);

	const n = points.length;
	// The in-progress month gets one extra slot on the x axis: month-to-date sits partway into it
	// (at the fraction of the month elapsed), the projection at its end.
	const ip = inProgress
		? (() => {
				const base = cum[n - 1] ?? 0;
				return {
					...inProgress,
					actual: base + metricDelta(inProgress.actual, mode),
					projected: base + metricDelta(inProgress.projected, mode),
					actualDelta: metricDelta(inProgress.actual, mode),
					projectedDelta: metricDelta(inProgress.projected, mode),
				};
			})()
		: null;
	const slots = n + (ip ? 1 : 0);
	const max = Math.max(...cum, ip?.projected ?? 0, 1);
	const x = (i: number) =>
		PAD.left + (slots === 1 ? innerW / 2 : (i / (slots - 1)) * innerW);
	const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
	const baseline = PAD.top + innerH;

	const line = points
		.map(
			(_, i) =>
				`${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(cum[i]).toFixed(1)}`,
		)
		.join(" ");
	const area = `${line} L${x(n - 1).toFixed(1)},${baseline} L${x(0).toFixed(1)},${baseline} Z`;

	const yTicks = Array.from({ length: 5 }, (_, i) => Math.round((max / 4) * i));
	const yearTicks = points
		.map((p, i) => ({ i, year: p.date.slice(0, 4) }))
		.filter((t, idx, arr) => idx === 0 || t.year !== arr[idx - 1].year);
	// Thin the year row so labels never crowd (bad on mobile, where the axis font is much larger).
	const xTicks = pickYearTicks(yearTicks, innerW, FONT.axis);

	// Show a dot per point, but thin out when there are many months so it stays sketchy, not noisy.
	const dotEvery = Math.max(1, Math.ceil(n / 60));

	function onMove(e: React.MouseEvent<SVGSVGElement>) {
		const rect = e.currentTarget.getBoundingClientRect();
		const frac = (e.clientX - rect.left) / rect.width; // viewBox scales proportionally
		const px = frac * W;
		const i = Math.round(((px - PAD.left) / innerW) * (slots - 1));
		setHover(Math.max(0, Math.min(slots - 1, i)));
	}

	const hoverIp = ip != null && hover === n;
	const hp = hover != null && !hoverIp ? points[hover] : null;
	const hx = hoverIp && ip ? ipX(ip.elapsed) : hover != null ? x(hover) : 0;
	const hcum = hoverIp && ip ? ip.actual : hover != null && hp ? cum[hover] : 0;
	function ipX(elapsed: number) {
		return x(n - 1) + elapsed * (x(n) - x(n - 1));
	}

	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			role="img"
			aria-label={`${title} over time`}
			className="chart-sketch block h-auto w-full text-foreground"
			onMouseMove={onMove}
			onMouseLeave={() => setHover(null)}
		>
			<defs>
				<linearGradient id="commitFill" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={ACCENT} stopOpacity={0.18} />
					<stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
				</linearGradient>
				{/* star-history's signature hand-drawn wobble */}
				<filter
					id="xkcdify"
					filterUnits="userSpaceOnUse"
					x={-5}
					y={-5}
					width="100%"
					height="100%"
				>
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.05"
						result="noise"
					/>
					<feDisplacementMap
						scale="4"
						xChannelSelector="R"
						yChannelSelector="G"
						in="SourceGraphic"
						in2="noise"
					/>
				</filter>
			</defs>

			{/* Title — hand-drawn, like "Star History"; reflects the metric on show */}
			<text
				x={PAD.left}
				y={28}
				fontSize={FONT.title}
				fontWeight={400}
				fill="currentColor"
			>
				{title}
			</text>

			{/* Y gridlines + labels */}
			{yTicks.map((v, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Rounded values may repeat, so we use indexes here
				<g key={i}>
					<line
						x1={PAD.left}
						x2={W - PAD.right}
						y1={y(v)}
						y2={y(v)}
						stroke="#e5e7eb"
						filter="url(#xkcdify)"
					/>
					<text
						x={PAD.left - 10}
						y={y(v)}
						textAnchor="end"
						dominantBaseline="middle"
						fill="#6b7280"
						fontSize={FONT.axis}
					>
						{compact(v)}
					</text>
				</g>
			))}

			{/* X year labels — sit just below the plot, above the credit line */}
			{xTicks.map((t) => (
				<text
					key={t.year}
					x={x(t.i)}
					y={baseline + FONT.axis + 10}
					textAnchor="middle"
					fill="#6b7280"
					fontSize={FONT.axis}
				>
					{t.year}
				</text>
			))}

			{/* Area + line + dots, all run through the hand-drawn filter */}
			<g filter="url(#xkcdify)">
				<path d={area} fill="url(#commitFill)" />
				<path
					d={line}
					fill="none"
					stroke={ACCENT}
					strokeWidth={2.5}
					strokeLinecap="round"
				/>
				{points.map((p, i) =>
					i % dotEvery === 0 || i === n - 1 ? (
						<circle
							key={p.date}
							cx={x(i)}
							cy={y(cum[i])}
							r={2.5}
							fill={ACCENT}
						/>
					) : null,
				)}
			</g>

			{/* In-progress month: dashed to the real month-to-date value, then fainter to the
			    projected month end. Kept off the wobble filter so short dashes stay legible. */}
			{ip && (
				<g>
					<path
						d={`M${x(n - 1).toFixed(1)},${y(cum[n - 1]).toFixed(1)} L${ipX(ip.elapsed).toFixed(1)},${y(ip.actual).toFixed(1)}`}
						fill="none"
						stroke={ACCENT}
						strokeWidth={2.5}
						strokeDasharray="5 4"
						strokeLinecap="round"
					/>
					<path
						d={`M${ipX(ip.elapsed).toFixed(1)},${y(ip.actual).toFixed(1)} L${x(n).toFixed(1)},${y(ip.projected).toFixed(1)}`}
						fill="none"
						stroke={ACCENT}
						strokeOpacity={0.45}
						strokeWidth={2}
						strokeDasharray="2 4"
						strokeLinecap="round"
					/>
					<circle
						cx={ipX(ip.elapsed)}
						cy={y(ip.actual)}
						r={3}
						fill="var(--background, #fff)"
						stroke={ACCENT}
						strokeWidth={1.5}
					/>
				</g>
			)}

			{label && (
				<ChartLegend
					entries={[{ label, color: ACCENT }]}
					x={PAD.left + 14}
					y={PAD.top + 6}
					font={FONT.legend}
				/>
			)}

			{/* Hover marker (kept crisp for precision) */}
			{hp && (
				<g>
					<line
						x1={hx}
						x2={hx}
						y1={PAD.top}
						y2={baseline}
						stroke="#9ca3af"
						strokeWidth={1}
					/>
					<circle
						cx={hx}
						cy={y(hcum)}
						r={4.5}
						fill={ACCENT}
						stroke="#fff"
						strokeWidth={1.5}
					/>
					<text
						x={Math.min(Math.max(hx, PAD.left + 80), W - PAD.right - 80)}
						y={PAD.top - 8}
						textAnchor="middle"
						fill="currentColor"
						fontSize={FONT.readout}
					>
						{monthLabel(hp.date)}: {hcum.toLocaleString()} total
						{dval(hp) ? ` (+${dval(hp)})` : ""}
					</text>
				</g>
			)}
			{hoverIp && ip && (
				<g>
					<line
						x1={hx}
						x2={hx}
						y1={PAD.top}
						y2={baseline}
						stroke="#9ca3af"
						strokeWidth={1}
						strokeDasharray="3 3"
					/>
					<text
						x={Math.min(Math.max(hx, PAD.left + 80), W - PAD.right - 150)}
						y={PAD.top - 8}
						textAnchor="middle"
						fill="currentColor"
						fontSize={FONT.readout}
					>
						{monthLabel(ip.date)} so far: +{ip.actualDelta.toLocaleString()}
						{" · on pace for ~+"}
						{ip.projectedDelta.toLocaleString()}
					</text>
				</g>
			)}

			<ChartAttribution x={W - PAD.right} y={H - 8} font={FONT.footer} />
		</svg>
	);
}
