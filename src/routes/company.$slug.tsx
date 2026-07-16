import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Permanent redirect from the old /company/<slug> explainer URLs to their current
 * /-/organizations/<slug> home (the collection was renamed when "companies" became
 * "organizations" site-wide, then moved under the reserved /-/ namespace). Points straight
 * at the final home so old links don't hop through two redirects. Bare /company still
 * falls through to the $user route as a valid GitHub login — same policy as /organizations.
 */
export const Route = createFileRoute("/company/$slug")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/-/organizations/$slug",
			params: { slug: params.slug },
			statusCode: 301,
		});
	},
});
