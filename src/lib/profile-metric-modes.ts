import type { LeaderMode } from "#/lib/commit-history";
import { availableMetrics } from "#/lib/metrics";
import type { LookupResult } from "#/lib/org";

export function profileMetricModes(
	lookup: LookupResult | undefined,
): LeaderMode[] | null {
	if (!lookup || lookup.kind === "org") return null;
	// A build blocks the whole page, including the root-level metric control. This also covers
	// adding a profile to an otherwise-loaded comparison: the picker returns with the page.
	if (lookup.users.some((result) => result.building)) return null;
	const histories = lookup.users
		.map((result) => result.history)
		.filter((history) => history != null);
	if (histories.length === 0) return null;
	const available = availableMetrics(histories);
	return available.length > 1 ? available : null;
}
