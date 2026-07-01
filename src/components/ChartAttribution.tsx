// The little "📈 commit-history.com" credit line in a chart's bottom-left corner — the same
// homage the /embed SVG carries (lib/chart-svg.ts), so a screenshotted live chart is self-
// attributing too. The 📈 is our favicon glyph (public/favicon.svg); it renders via the system
// emoji font, while the domain text inherits the chart's hand-drawn xkcd face.

export function ChartAttribution({
	x,
	y,
	font,
}: {
	x: number;
	y: number;
	/** Font size in viewBox units, so it scales with the chart's mobile/desktop layout. */
	font: number;
}) {
	return (
		<text x={x} y={y} fill="#6b7280" fontSize={font}>
			<tspan fontSize={font * 1.15}>📈</tspan>
			<tspan dx={font * 0.35}>commit-history.com</tspan>
		</text>
	);
}
