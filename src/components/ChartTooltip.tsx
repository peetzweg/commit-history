// Floating hover readout, à la the in-chart legend: a wobbly rounded box (run through the
// chart's #xkcdify filter) with a date header and one row per series — color swatch + label +
// value. It self-places next to the cursor and clamps inside the plot bounds so it never spills
// past the chart edge. Only the border and swatches get the hand-drawn wobble; text stays crisp.

export interface TooltipRow {
	label: string;
	value: string;
	color: string;
}

// Geometry is expressed relative to the font size (tuned for 15px) so the box scales with the
// chart's larger mobile labels, mirroring ChartLegend.
const BASE_FONT = 15;
const ROW_H = 24 / BASE_FONT;
const PAD_X = 13 / BASE_FONT;
const PAD_Y = 8 / BASE_FONT;
const SWATCH = 12 / BASE_FONT;
const GAP = 9 / BASE_FONT;
// Space between a row's label and its right-aligned value.
const COL_GAP = 18 / BASE_FONT;
// The xkcd font's metrics aren't measurable at render time, so widths are approximated from
// character counts.
const CHAR_W = 8.4 / BASE_FONT;
// How far to sit from the cursor before clamping.
const OFFSET = 16 / BASE_FONT;

export function ChartTooltip({
	title,
	rows,
	anchorX,
	anchorY,
	bounds,
	font = BASE_FONT,
}: {
	title: string;
	rows: TooltipRow[];
	/** Cursor position (viewBox units) the box floats beside. */
	anchorX: number;
	anchorY: number;
	/** Plot area the box must stay within (viewBox units). */
	bounds: { left: number; right: number; top: number; bottom: number };
	font?: number;
}) {
	if (rows.length === 0) return null;
	const rowH = ROW_H * font;
	const padX = PAD_X * font;
	const padY = PAD_Y * font;
	const swatch = SWATCH * font;
	const gap = GAP * font;
	const colGap = COL_GAP * font;
	const charW = CHAR_W * font;
	const offset = OFFSET * font;

	const rowW = (r: TooltipRow) =>
		swatch + gap + (r.label.length + r.value.length) * charW + colGap;
	const contentW = Math.max(title.length * charW, ...rows.map(rowW));
	const boxW = padX * 2 + contentW;
	const lines = rows.length + 1; // header + one per series
	const boxH = padY * 2 + lines * rowH;

	// Prefer the right of the cursor; flip left if it would overflow, then clamp both axes.
	let bx = anchorX + offset;
	if (bx + boxW > bounds.right) bx = anchorX - offset - boxW;
	bx = Math.max(bounds.left, Math.min(bx, bounds.right - boxW));
	let by = anchorY - boxH / 2;
	by = Math.max(bounds.top, Math.min(by, bounds.bottom - boxH));

	const lineY = (i: number) => by + padY + i * rowH + rowH / 2;
	const valueRight = bx + padX + contentW;

	return (
		<g>
			<rect
				x={bx}
				y={by}
				width={boxW}
				height={boxH}
				rx={10}
				fill="var(--background, #fff)"
				stroke="currentColor"
				strokeWidth={2}
				filter="url(#xkcdify)"
			/>
			<text
				x={bx + padX}
				y={lineY(0)}
				fontSize={font}
				fontWeight={600}
				dominantBaseline="central"
				fill="currentColor"
			>
				{title}
			</text>
			{rows.map((r, i) => (
				<g key={r.label}>
					<rect
						x={bx + padX}
						y={lineY(i + 1) - swatch / 2}
						width={swatch}
						height={swatch}
						rx={3}
						fill={r.color}
						filter="url(#xkcdify)"
					/>
					<text
						x={bx + padX + swatch + gap}
						y={lineY(i + 1)}
						fontSize={font}
						dominantBaseline="central"
						fill="currentColor"
					>
						{r.label}
					</text>
					<text
						x={valueRight}
						y={lineY(i + 1)}
						fontSize={font}
						textAnchor="end"
						fontWeight={600}
						dominantBaseline="central"
						fill={r.color}
					>
						{r.value}
					</text>
				</g>
			))}
		</g>
	);
}
