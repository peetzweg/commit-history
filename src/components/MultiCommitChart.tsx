import { useState } from "react";
import { ChartLegend } from "#/components/ChartLegend";
import { type ChartMode, cumulativeSeries } from "#/components/CommitChart";
import type { CommitPoint } from "#/lib/github";
import { useIsMobile } from "#/lib/useIsMobile";

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
const W = 880;
const H = 420;

const DESKTOP = {
	pad: { top: 40, right: 24, bottom: 30, left: 60 },
	font: { axis: 16, readout: 15, legend: 16 },
};
const MOBILE = {
	pad: { top: 46, right: 16, bottom: 44, left: 88 },
	font: { axis: 26, readout: 22, legend: 24 },
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

export function MultiCommitChart({
	series,
	mode,
	chartMode = "public",
}: {
	series: ChartSeries[];
	mode: TimelineMode;
	chartMode?: ChartMode;
}) {
	const [hoverFrac, setHoverFrac] = useState<number | null>(null);
	const isMobile = useIsMobile();
	const { pad: PAD, font: FONT } = isMobile ? MOBILE : DESKTOP;
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;
	if (series.length === 0 || series.every((s) => s.points.length === 0)) {
		return null;
	}

	// Cumulative series per line, for the selected metric (indexed the same as `series`).
	const seriesCum = series.map((s) => cumulativeSeries(s.points, chartMode));

	const yMax = Math.max(1, ...seriesCum.flat());
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

	function buildLine(s: ChartSeries, si: number) {
		return s.points
			.map(
				(_, i) =>
					`${i === 0 ? "M" : "L"}${xOf(s, i).toFixed(1)},${y(seriesCum[si][i]).toFixed(1)}`,
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
		setHoverFrac(
			Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
		);
	}

	// Resolve hover to a point per series.
	const hoverX = hoverFrac == null ? null : PAD.left + hoverFrac * innerW;
	function hoverPoint(s: ChartSeries): { i: number } | null {
		if (hoverFrac == null) return null;
		if (mode === "aligned") {
			const i = Math.round(hoverFrac * (maxLen - 1));
			return i < s.points.length ? { i } : null;
		}
		const mi = t0 + hoverFrac * (t1 - t0);
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
			onMouseLeave={() => setHoverFrac(null)}
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
					y={H - 10}
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
						d={`${buildLine(series[0], 0)} L${xOf(series[0], series[0].points.length - 1).toFixed(1)},${baseline} L${xOf(series[0], 0).toFixed(1)},${baseline} Z`}
						fill="url(#fill0)"
					/>
				)}
				{series.map((s, si) => (
					<path
						key={s.login}
						d={buildLine(s, si)}
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

			{/* Hover: vertical guide + a dot and value per series */}
			{hoverX != null && (
				<g>
					<line
						x1={hoverX}
						x2={hoverX}
						y1={PAD.top}
						y2={baseline}
						stroke="#9ca3af"
						strokeWidth={1}
					/>
					{series.map((s, si) => {
						const hp = hoverPoint(s);
						if (!hp) return null;
						const px = xOf(s, hp.i);
						const py = y(seriesCum[si][hp.i]);
						return (
							<g key={s.login}>
								<circle
									cx={px}
									cy={py}
									r={4}
									fill={s.color}
									stroke="#fff"
									strokeWidth={1.5}
								/>
								<text
									x={px + 8}
									y={py - 6}
									fontSize={FONT.readout}
									fill={s.color}
									fontWeight={600}
								>
									{seriesCum[si][hp.i].toLocaleString()}
								</text>
							</g>
						);
					})}
					{/* x label for the hovered position (date mode shows the month) */}
					{mode === "date" && series[0] && (
						<text
							x={Math.min(Math.max(hoverX, PAD.left + 40), W - PAD.right - 40)}
							y={PAD.top - 6}
							textAnchor="middle"
							fontSize={FONT.readout}
							fill="currentColor"
						>
							{(() => {
								const hp = hoverPoint(series[0]);
								return hp ? monthLabel(series[0].points[hp.i].date) : "";
							})()}
						</text>
					)}
				</g>
			)}
		</svg>
	);
}
