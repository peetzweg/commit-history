import { Link } from "@tanstack/react-router";
import type { LeaderMode } from "#/lib/commit-history";
import { METRIC_EXPLAINER } from "#/lib/metrics";

/**
 * Tertiary "What is this?" link to the /-/metrics explainer article for the given metric.
 * Deliberately quiet: it inherits the muted small-print style of the caption/subtitle
 * it sits in, with only a dotted underline announcing it's clickable.
 */
export function ExplainerLink({ metric }: { metric: LeaderMode }) {
	return (
		<Link
			to="/-/metrics/$slug"
			params={{ slug: METRIC_EXPLAINER[metric] }}
			className="whitespace-nowrap underline decoration-dotted underline-offset-2 hover:text-foreground"
		>
			What is this?
		</Link>
	);
}
