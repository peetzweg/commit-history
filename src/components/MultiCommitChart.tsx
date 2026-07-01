import { useState } from "react";
import { ChartAttribution } from "#/components/ChartAttribution";
import { ChartLegend } from "#/components/ChartLegend";
import { ChartTooltip } from "#/components/ChartTooltip";
import { type ChartMode, chartTitle } from "#/components/CommitChart";
import type { CommitPoint } from "#/lib/github";
import { useIsMobile } from "#/lib/useIsMobile";

/** Cumulative value to plot for a point, per the public/private/both selection.
 *  "both" sums public commits and private contributions. */
export function chartValue(p: CommitPoint, mode: ChartMode) {
	return mode === "public"
		? p.cumulative
		: mode === "private"
			? p.restrictedCumulative
			: p.cumulative + p.restrictedCumulative;
}

/** Commits added in this point's own month (the non-cumulative delta), per selection. */
export function chartDelta(p: CommitPoint, mode: ChartMode) {
	return mode === "public"
		? p.commits
		: mode === "private"
			? p.restricted
			: p.commits + p.restricted;
}

// First color is star-history's brand green; the rest are a distinguishable palette.
export const SERIES_COLORS = [
	"#16a34a",
	"#f26065",
	"#f59e0b",
	"#3b82f6",
	"#a855f7",
	"#ec4899",
	"#0891b2",
	"#65a30d",
];

export type TimelineMode = "date" | "aligned";

export interface ChartSeries {
	login: string;
	color: string;
	points: CommitPoint[];
}

// Fixed viewBox scaled to container width — see CommitChart for why the layout is responsive.
// Layout mirrors CommitChart so the single- and multi-user charts read identically: a hand-drawn
// title up top, year labels and the credit line stacked under the plot.
const W = 880;
const H = 420;

const DESKTOP = {
	pad: { top: 48, right: 24, bottom: 54, left: 60 },
	font: { title: 24, axis: 16, readout: 15, legend: 16, footer: 13 },
};
const MOBILE = {
	pad: { top: 56, right: 16, bottom: 72, left: 88 },
	font: { title: 32, axis: 26, readout: 22, legend: 24, footer: 20 },
};

function compact(n: number) {
	return new Intl.NumberFormat("en-US", { notation: "compact" }).format(n);
}

function monthIndex(date: string) {
	const [y, m] = date.split("-");
	return Number(y) * 12 + (Number(m) - 1);
}

function monthLabel(date: string) {
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		year: "numeric",
	});
}

// Inverse of monthIndex: build a first-of-month date string for a month index.
function monthLabelFromIndex(mi: number) {
	const year = Math.floor(mi / 12);
	const month = (mi % 12) + 1;
	return monthLabel(`${year}-${String(month).padStart(2, "0")}-01`);
}

// Human label for an aligned-timeline step (months since each series' own start).
function alignedStepLabel(i: number) {
	if (i <= 0) return "Start";
	const years = Math.floor(i / 12);
	const months = i % 12;
	if (years === 0) return `${months} mo`;
	if (months === 0) return `${years}y`;
	return `${years}y ${months}mo`;
}

export function MultiCommitChart({
	series,
	mode,
	chartMode = "public",
	title = chartTitle(chartMode),
}: {
	series: ChartSeries[];
	mode: TimelineMode;
	chartMode?: ChartMode;
	/** Hand-drawn heading; defaults to the metric's title (see chartTitle). */
	title?: string;
}) {
	const [hover, setHover] = useState<{ frac: number; y: number } | null>(null);
	const hoverFrac = hover?.frac ?? null;
	const isMobile = useIsMobile();
	const { pad: PAD, font: FONT } = isMobile ? MOBILE : DESKTOP;
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;
	if (series.length === 0 || series.every((s) => s.points.length === 0)) {
		return null;
	}

	const cval = (p: CommitPoint) => chartValue(p, chartMode);
	const dcval = (p: CommitPoint) => chartDelta(p, chartMode);

	const yMax = Math.max(1, ...series.flatMap((s) => s.points.map(cval)));
	const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
	const baseline = PAD.top + innerH;

	// X mapping differs by mode.
	const starts = series.map((s) => monthIndex(s.points[0].date));
	const ends = series.map((s) =>
		monthIndex(s.points[s.points.length - 1].date),
	);
	const t0 = Math.min(...starts);
	const t1 = Math.max(...ends);
	const maxLen = Math.max(...series.map((s) => s.points.length));

	const xDate = (mi: number) =>
		PAD.left + (t1 === t0 ? innerW / 2 : ((mi - t0) / (t1 - t0)) * innerW);
	const xAligned = (i: number) =>
		PAD.left + (maxLen <= 1 ? innerW / 2 : (i / (maxLen - 1)) * innerW);
	const xOf = (s: ChartSeries, i: number) =>
		mode === "date" ? xDate(monthIndex(s.points[i].date)) : xAligned(i);

	const single = series.length === 1;

	function buildLine(s: ChartSeries) {
		return s.points
			.map(
				(p, i) =>
					`${i === 0 ? "M" : "L"}${xOf(s, i).toFixed(1)},${y(cval(p)).toFixed(1)}`,
			)
			.join(" ");
	}

	// Y gridlines.
	const yTicks = Array.from({ length: 5 }, (_, i) =>
		Math.round((yMax / 4) * i),
	);

	// X ticks: calendar years (date) or "Ny since start" (aligned).
	const xTicks: { x: number; label: string }[] = [];
	if (mode === "date") {
		const y0 = Math.ceil(t0 / 12);
		const y1 = Math.floor(t1 / 12);
		const span = Math.max(1, y1 - y0);
		const step = span > 12 ? 2 : 1;
		for (let yr = y0; yr <= y1; yr += step) {
			xTicks.push({ x: xDate(yr * 12), label: String(yr) });
		}
	} else {
		const years = Math.floor((maxLen - 1) / 12);
		const step = years > 12 ? 2 : 1;
		for (let yr = 0; yr <= years; yr += step) {
			xTicks.push({
				x: xAligned(yr * 12),
				label: yr === 0 ? "start" : `${yr}y`,
			});
		}
	}

	function onMove(e: React.MouseEvent<SVGSVGElement>) {
		const rect = e.currentTarget.getBoundingClientRect();
		// Convert the pointer to viewBox units, then to a fraction of the *plot*
		// area (not the full width) — otherwise the guide line drifts left of the
		// cursor by the left padding.
		const svgX = ((e.clientX - rect.left) / rect.width) * W;
		const svgY = ((e.clientY - rect.top) / rect.height) * H;
		setHover({
			frac: Math.max(0, Math.min(1, (svgX - PAD.left) / innerW)),
			y: svgY,
		});
	}

	// Resolve hover to a point per series.
	const hoverX = hoverFrac == null ? null : PAD.left + hoverFrac * innerW;
	// The month (date mode) / step index (aligned mode) under the cursor, independent
	// of any single series — so the readout's header reflects where the mouse is, not
	// whichever series happens to be closest.
	const hoverMonth =
		hoverFrac == null ? null : Math.round(t0 + hoverFrac * (t1 - t0));
	const hoverStep =
		hoverFrac == null ? null : Math.round(hoverFrac * (maxLen - 1));
	function hoverPoint(s: ChartSeries): { i: number } | null {
		if (hoverFrac == null) return null;
		if (mode === "aligned") {
			const i = hoverStep as number;
			return i < s.points.length ? { i } : null;
		}
		// Only report this series where its line actually exists: skip months before
		// it started or after it ended. Within range, snap to the nearest point.
		const mi = hoverMonth as number;
		const start = monthIndex(s.points[0].date);
		const end = monthIndex(s.points[s.points.length - 1].date);
		if (mi < start || mi > end) return null;
		let best = 0;
		let bestD = Infinity;
		s.points.forEach((p, i) => {
			const d = Math.abs(monthIndex(p.date) - mi);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		});
		return { i: best };
	}

	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			role="img"
			aria-label="Cumulative commits over time"
			className="chart-sketch block h-auto w-full text-foreground"
			onMouseMove={onMove}
			onMouseLeave={() => setHover(null)}
		>
			<defs>
				{single && (
					<linearGradient id="fill0" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor={series[0].color} stopOpacity={0.18} />
						<stop offset="100%" stopColor={series[0].color} stopOpacity={0} />
					</linearGradient>
				)}
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

			{/* Title — hand-drawn, matching the single-user chart; reflects the metric on show */}
			<text
				x={PAD.left}
				y={28}
				fontSize={FONT.title}
				fontWeight={400}
				fill="currentColor"
			>
				{title}
			</text>

			{yTicks.map((v) => (
				<g key={v}>
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

			{xTicks.map((t) => (
				<text
					key={`${t.label}-${t.x.toFixed(0)}`}
					x={t.x}
					y={baseline + FONT.axis + 10}
					textAnchor="middle"
					fill="#6b7280"
					fontSize={FONT.axis}
				>
					{t.label}
				</text>
			))}

			<g filter="url(#xkcdify)">
				{single && (
					<path
						d={`${buildLine(series[0])} L${xOf(series[0], series[0].points.length - 1).toFixed(1)},${baseline} L${xOf(series[0], 0).toFixed(1)},${baseline} Z`}
						fill="url(#fill0)"
					/>
				)}
				{series.map((s) => (
					<path
						key={s.login}
						d={buildLine(s)}
						fill="none"
						stroke={s.color}
						strokeWidth={2.5}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				))}
			</g>

			<ChartLegend
				entries={series.map((s) => ({ label: s.login, color: s.color }))}
				x={PAD.left + 14}
				y={PAD.top + 6}
				font={FONT.legend}
			/>

			{/* Hover: vertical guide + a dot per series + one floating readout box */}
			{hoverX != null && hover != null && (
				<g>
					<line
						x1={hoverX}
						x2={hoverX}
						y1={PAD.top}
						y2={baseline}
						stroke="#9ca3af"
						strokeWidth={1}
					/>
					{series.map((s) => {
						const hp = hoverPoint(s);
						if (!hp) return null;
						const p = s.points[hp.i];
						return (
							<circle
								key={s.login}
								cx={xOf(s, hp.i)}
								cy={y(cval(p))}
								r={4}
								fill={s.color}
								stroke="#fff"
								strokeWidth={1.5}
							/>
						);
					})}
					{(() => {
						const rows = series
							.map((s) => {
								const hp = hoverPoint(s);
								if (!hp) return null;
								const p = s.points[hp.i];
								const delta = dcval(p);
								// Total, with the month's own additions in brackets behind it.
								const value =
									delta > 0
										? `${cval(p).toLocaleString()} (+${delta.toLocaleString()})`
										: cval(p).toLocaleString();
								return { label: s.login, value, color: s.color };
							})
							.filter((r): r is NonNullable<typeof r> => r != null);
						const readoutTitle =
							mode === "date"
								? hoverMonth != null
									? monthLabelFromIndex(hoverMonth)
									: ""
								: hoverStep != null
									? alignedStepLabel(hoverStep)
									: "";
						return (
							<ChartTooltip
								title={readoutTitle}
								rows={rows}
								anchorX={hoverX}
								anchorY={hover.y}
								bounds={{
									left: PAD.left,
									right: W - PAD.right,
									top: PAD.top,
									bottom: baseline,
								}}
								font={FONT.readout}
							/>
						);
					})()}
				</g>
			)}

			<ChartAttribution x={W - PAD.right} y={H - 8} font={FONT.footer} />
		</svg>
	);
}
