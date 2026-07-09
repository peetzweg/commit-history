// Shared x-axis year-label thinning for the commit charts. On a phone (and sometimes even on the
// web) a label-per-year row overflows: 17+ four-digit years can't fit across an 880-unit viewBox
// once the mobile axis font jumps to 26. So we keep only as many labels as the width allows,
// choosing a "nice" step (every 1 / 2 / 5 / 10 … years) and anchoring the survivors to round years
// (…2015, 2020, 2025). Round multiples read as deliberate year markers, not an arbitrary offset.

// Nice steps, in years. We climb this ladder until the kept labels fit.
const STEPS = [1, 2, 5, 10, 25, 50, 100];

// Rough advance width of a digit in the xkcd hand-drawn font, as a fraction of the font size, plus
// a fixed gap so neighbouring labels never kiss. Deliberately generous — over-estimating width just
// drops a label, which is far safer than letting two overlap.
const GLYPH = 0.6;
const GAP = 14;

/**
 * How many years to skip between kept labels so `spanYears + 1` labels fit within `innerW`.
 * Returns a value from {@link STEPS} (1 = show every year). `labelChars` is the widest label's
 * character count (4 for a calendar year like "2026").
 */
export function niceYearStep(
	spanYears: number,
	innerW: number,
	fontSize: number,
	labelChars = 4,
): number {
	const labelW = fontSize * labelChars * GLYPH + GAP;
	const maxLabels = Math.max(2, Math.floor(innerW / labelW));
	const count = spanYears + 1;
	if (count <= maxLabels) return 1;
	return STEPS.find((s) => Math.ceil(count / s) <= maxLabels) ?? 100;
}

/**
 * Filter a one-entry-per-year tick list down to a non-crowding subset. Keeps years that are
 * multiples of the {@link niceYearStep}, so the labels that remain are round (…2015, 2020). Lists of
 * two or fewer are returned untouched.
 */
export function pickYearTicks<T extends { year: string }>(
	ticks: T[],
	innerW: number,
	fontSize: number,
): T[] {
	if (ticks.length <= 2) return ticks;
	const first = Number(ticks[0].year);
	const last = Number(ticks[ticks.length - 1].year);
	const step = niceYearStep(last - first, innerW, fontSize);
	if (step === 1) return ticks;
	return ticks.filter((t) => Number(t.year) % step === 0);
}
