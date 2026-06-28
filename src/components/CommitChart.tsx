import { useState } from "react";
import { ChartLegend } from "#/components/ChartLegend";
import type { CommitPoint } from "#/lib/github";

// Fixed viewBox; the <svg> scales to its container via width:100%. No DOM measurement, so this
// renders identically on the server (and can be reused verbatim for the /$user.svg embed).
const W = 880;
const H = 420;
const PAD = { top: 48, right: 24, bottom: 36, left: 60 };
const innerW = W - PAD.left - PAD.right;
const innerH = H - PAD.top - PAD.bottom;

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

export type ChartMode = "public" | "private" | "both";

export function CommitChart({
	points,
	mode = "both",
	label,
}: {
	points: CommitPoint[];
	mode?: ChartMode;
	/** Username shown in the in-chart legend (omit to hide the legend). */
	label?: string;
}) {
	const [hover, setHover] = useState<number | null>(null);
	if (points.length === 0) return null;

	// Cumulative value to plot, and the month's delta — per the selected mode.
	// "both" is the per-month sum of public commits + private contributions.
	const cval = (p: CommitPoint) =>
		mode === "public"
			? p.cumulative
			: mode === "private"
				? p.restrictedCumulative
				: p.cumulative + p.restrictedCumulative;
	const dval = (p: CommitPoint) =>
		mode === "public"
			? p.commits
			: mode === "private"
				? p.restricted
				: p.commits + p.restricted;

	const n = points.length;
	const max = Math.max(...points.map(cval), 1);
	const x = (i: number) =>
		PAD.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
	const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
	const baseline = PAD.top + innerH;

	const line = points
		.map(
			(p, i) =>
				`${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(cval(p)).toFixed(1)}`,
		)
		.join(" ");
	const area = `${line} L${x(n - 1).toFixed(1)},${baseline} L${x(0).toFixed(1)},${baseline} Z`;

	const yTicks = Array.from({ length: 5 }, (_, i) => Math.round((max / 4) * i));
	const xTicks = points
		.map((p, i) => ({ i, year: p.date.slice(0, 4) }))
		.filter((t, idx, arr) => idx === 0 || t.year !== arr[idx - 1].year);

	// Show a dot per point, but thin out when there are many months so it stays sketchy, not noisy.
	const dotEvery = Math.max(1, Math.ceil(n / 60));

	function onMove(e: React.MouseEvent<SVGSVGElement>) {
		const rect = e.currentTarget.getBoundingClientRect();
		const frac = (e.clientX - rect.left) / rect.width; // viewBox scales proportionally
		const px = frac * W;
		const i = Math.round(((px - PAD.left) / innerW) * (n - 1));
		setHover(Math.max(0, Math.min(n - 1, i)));
	}

	const hp = hover != null ? points[hover] : null;
	const hx = hover != null ? x(hover) : 0;

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

			{/* Title — hand-drawn, like "Star History" */}
			<text
				x={PAD.left}
				y={28}
				fontSize={22}
				fontWeight={400}
				fill="currentColor"
			>
				Commit History
			</text>

			{/* Y gridlines + labels */}
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
						fontSize={14}
					>
						{compact(v)}
					</text>
				</g>
			))}

			{/* X year labels */}
			{xTicks.map((t) => (
				<text
					key={t.year}
					x={x(t.i)}
					y={H - 10}
					textAnchor="middle"
					fill="#6b7280"
					fontSize={14}
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
							cy={y(cval(p))}
							r={2.5}
							fill={ACCENT}
						/>
					) : null,
				)}
			</g>

			{label && (
				<ChartLegend
					entries={[{ label, color: ACCENT }]}
					x={PAD.left + 14}
					y={PAD.top + 6}
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
						cy={y(cval(hp))}
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
						fontSize={15}
					>
						{monthLabel(hp.date)}: {cval(hp).toLocaleString()} total
						{dval(hp) ? ` (+${dval(hp)})` : ""}
					</text>
				</g>
			)}
		</svg>
	);
}
