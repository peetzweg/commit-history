// In-chart hand-drawn legend box, à la star-history.com: a wobbly rounded border (run through
// the chart's #xkcdify filter) with a color swatch + label per series, sitting in the chart's
// empty top-left corner. Only the border and swatches get the hand-drawn wobble — the text is
// left crisp so it stays readable.

export interface LegendEntry {
	label: string;
	color: string;
}

// Geometry is expressed relative to the font size (the defaults below are tuned for a 15px
// label) so the whole box scales when the chart grows its labels on mobile.
const BASE_FONT = 15;
const ROW_H = 25 / BASE_FONT;
const PAD_X = 13 / BASE_FONT;
const PAD_Y = 11 / BASE_FONT;
const SWATCH = 13 / BASE_FONT;
const GAP = 10 / BASE_FONT;
// The xkcd font's metrics aren't available at render time (SSR, fixed viewBox, no DOM measure),
// so the box width is approximated from each label's character count.
const CHAR_W = 8.4 / BASE_FONT;

export function ChartLegend({
	entries,
	x,
	y,
	font = BASE_FONT,
}: {
	entries: LegendEntry[];
	x: number;
	y: number;
	/** Label font size in viewBox units; the box scales with it. */
	font?: number;
}) {
	if (entries.length === 0) return null;
	const rowH = ROW_H * font;
	const padX = PAD_X * font;
	const padY = PAD_Y * font;
	const swatch = SWATCH * font;
	const gap = GAP * font;
	const longest = Math.max(...entries.map((e) => e.label.length));
	const boxW = padX * 2 + swatch + gap + longest * CHAR_W * font;
	const boxH = padY * 2 + entries.length * rowH - (rowH - font);

	return (
		<g>
			<rect
				x={x}
				y={y}
				width={boxW}
				height={boxH}
				rx={10}
				fill="var(--background, #fff)"
				stroke="currentColor"
				strokeWidth={2}
				filter="url(#xkcdify)"
			/>
			{entries.map((e, i) => {
				const rowTop = y + padY + i * rowH;
				return (
					<g key={e.label}>
						<rect
							x={x + padX}
							y={rowTop}
							width={swatch}
							height={swatch}
							rx={3}
							fill={e.color}
							filter="url(#xkcdify)"
						/>
						<text
							x={x + padX + swatch + gap}
							y={rowTop + swatch - 1}
							fontSize={font}
							fill="currentColor"
						>
							{e.label}
						</text>
					</g>
				);
			})}
		</g>
	);
}
