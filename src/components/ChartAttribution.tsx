import {
	CROWN_ASPECT,
	CROWN_FILL,
	CROWN_PATH,
	CROWN_TRANSFORM,
	CROWN_VIEWBOX,
} from "#/lib/crown";

// The little "👑 commit-history.com" credit line in a chart's bottom-right corner — the same
// homage the /embed SVG carries (lib/chart-svg.ts), so a screenshotted live chart is self-
// attributing too. The crown is our logo (public/crown.svg), scaled into a nested <svg>; the
// domain text inherits the chart's hand-drawn xkcd face.

const TEXT = "commit-history.com";
// Average xkcd glyph advance as a fraction of the font size — the same approximation ChartLegend
// uses to size its box without a DOM to measure against. Used to right-align the whole credit.
const CHAR_W = 0.56;

export function ChartAttribution({
	x,
	y,
	font,
}: {
	/** Right edge to align the credit against (the plot's right side). */
	x: number;
	/** Text baseline. */
	y: number;
	/** Font size in viewBox units, so it scales with the chart's mobile/desktop layout. */
	font: number;
}) {
	const crownH = font * 1.5;
	const crownW = crownH * CROWN_ASPECT;
	const gap = font * 0.3;
	const textW = TEXT.length * CHAR_W * font;
	const startX = x - textW - gap - crownW;
	return (
		<g>
			<svg
				x={startX}
				y={y - crownH * 0.82}
				width={crownW}
				height={crownH}
				viewBox={CROWN_VIEWBOX}
				aria-hidden="true"
			>
				<g transform={CROWN_TRANSFORM}>
					<path fill={CROWN_FILL} d={CROWN_PATH} />
				</g>
			</svg>
			<text x={x} y={y} textAnchor="end" fill="#6b7280" fontSize={font}>
				{TEXT}
			</text>
		</g>
	);
}
