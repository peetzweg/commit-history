import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Permanent redirect from the old /organizations/<slug> explainer URLs to their new home
 * under the reserved /-/ namespace. Kept as a thin route so existing links and
 * search-engine results don't 404. Bare /organizations still falls through to the $user
 * route as a valid GitHub login.
 */
export const Route = createFileRoute("/organizations/$slug")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/-/organizations/$slug",
			params: { slug: params.slug },
			statusCode: 301,
		});
	},
});
