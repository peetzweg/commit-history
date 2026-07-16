import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Permanent redirect from the old /metrics/<slug> explainer URLs to their new home under
 * the reserved /-/ namespace. Kept as a thin route so existing links and search-engine
 * results don't 404. Bare /metrics still falls through to the $user route as a valid
 * GitHub login.
 */
export const Route = createFileRoute("/metrics/$slug")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/-/metrics/$slug",
			params: { slug: params.slug },
			statusCode: 301,
		});
	},
});
