const nf = new Intl.NumberFormat("en-US");

/** Grouped integer; "—" for an unmeasured (null) value so it never reads as a real 0. */
export function fmt(n: number | null | undefined): string {
	return n == null ? "—" : nf.format(n);
}

/** A stats-derived value from truncated statistics is a lower bound; show it as one. */
export function fmtLowerBound(
	n: number | null | undefined,
	truncated: boolean,
): string {
	return truncated && n != null ? `≥${fmt(n)}` : fmt(n);
}

export function relativeAge(iso: string | null, now = Date.now()): string {
	if (!iso) return "never";
	const hours = (now - Date.parse(iso)) / 3_600_000;
	if (hours < 1) return "just now";
	if (hours < 48) return `${Math.round(hours)}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
