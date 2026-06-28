// In-chart hand-drawn legend box, à la star-history.com: a wobbly rounded border (run through
// the chart's #xkcdify filter) with a color swatch + label per series, sitting in the chart's
// empty top-left corner. Only the border and swatches get the hand-drawn wobble — the text is
// left crisp so it stays readable.

export interface LegendEntry {
	label: string;
	color: string;
}

const FONT = 15;
const ROW_H = 25;
const PAD_X = 13;
const PAD_Y = 11;
const SWATCH = 13;
const GAP = 10;
// The xkcd font's metrics aren't available at render time (SSR, fixed viewBox, no DOM measure),
// so the box width is approximated from each label's character count.
const CHAR_W = 8.4;

export function ChartLegend({
	entries,
	x,
	y,
}: {
	entries: LegendEntry[];
	x: number;
	y: number;
}) {
	if (entries.length === 0) return null;
	const longest = Math.max(...entries.map((e) => e.label.length));
	const boxW = PAD_X * 2 + SWATCH + GAP + longest * CHAR_W;
	const boxH = PAD_Y * 2 + entries.length * ROW_H - (ROW_H - FONT);

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
				const rowTop = y + PAD_Y + i * ROW_H;
				return (
					<g key={e.label}>
						<rect
							x={x + PAD_X}
							y={rowTop}
							width={SWATCH}
							height={SWATCH}
							rx={3}
							fill={e.color}
							filter="url(#xkcdify)"
						/>
						<text
							x={x + PAD_X + SWATCH + GAP}
							y={rowTop + SWATCH - 1}
							fontSize={FONT}
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
