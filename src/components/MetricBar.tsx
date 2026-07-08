import { useMatch, useNavigate, useRouterState } from "@tanstack/react-router";
import { SegmentedControl } from "#/components/SegmentedControl";
import type { LeaderMode } from "#/lib/commit-history";
import { ALL_METRICS, availableMetrics, METRIC_LABEL } from "#/lib/metrics";
import type { LookupResult } from "#/lib/org";

// The leaderboard offers every metric; the chart offers the subset a profile actually has data for.
const LEADER_MODES: LeaderMode[] = [
	"public",
	"prs",
	"issues",
	"reviews",
	"repos",
	"private",
	"total",
	"followers",
];

/**
 * The floating metric tab bar, rendered ONCE at the app root so it's a single persistent element
 * across navigations — that's what lets it grow/shrink with a real layout animation (e.g. dropping
 * "Followers" when you go from the leaderboard to a profile) instead of being replaced.
 *
 * It reads the current route + `?metric=` and drives the right control: the leaderboard ranking on
 * the home page, the chart metric on a profile (the full set while a profile loads, then narrowing
 * to what's actually available). It's absent on routes with no metric to pick (e.g. 404).
 */
export function MetricBar() {
	const navigate = useNavigate();
	const { routeId, metric, boardKind } = useRouterState({
		select: (s) => ({
			routeId: s.matches[s.matches.length - 1]?.routeId as string | undefined,
			metric: (s.location.search as { metric?: string }).metric,
			boardKind: (s.location.search as { kind?: string }).kind,
		}),
	});
	// Defined only while the /$user route is active and its loader has resolved (undefined elsewhere
	// and during loading).
	const userMatch = useMatch({ from: "/$user", shouldThrow: false });
	const lookup = userMatch?.loaderData as LookupResult | undefined;

	let modes: LeaderMode[] | null = null;
	if (routeId === "/") {
		// The company board (?kind=org) ranks by commits only — no metric to pick yet.
		modes = boardKind === "org" ? null : LEADER_MODES;
	} else if (routeId === "/$user") {
		if (lookup?.kind === "org") {
			// Org pages have a single number set — nothing to pick (no per-metric boards yet).
			modes = null;
		} else {
			const histories = (lookup?.users ?? [])
				.map((r) => r.history)
				.filter((h) => h != null);
			if (histories.length === 0) {
				// Loader still pending — show the full set so the bar is present during loading.
				modes = ALL_METRICS;
			} else {
				const avail = availableMetrics(histories);
				// A lone metric (commits only) isn't worth a picker.
				modes = avail.length > 1 ? avail : null;
			}
		}
	}

	const present = modes !== null;
	const options = (modes ?? []).map((m) => ({
		value: m,
		label: METRIC_LABEL[m],
	}));
	const current = (metric ?? "public") as LeaderMode;
	const value = options.some((o) => o.value === current) ? current : "public";

	const onChange = (m: LeaderMode) =>
		navigate({
			to: ".",
			search: (prev) => ({
				...prev,
				metric: m === "public" ? undefined : m,
			}),
			replace: true,
			resetScroll: false,
		});

	if (!present) return null;
	return (
		<SegmentedControl options={options} value={value} onChange={onChange} />
	);
}
