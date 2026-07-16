import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Permanent redirect from the old hub URL to /-/metrics. "explained" only existed because
 * content sections couldn't own their bare prefix outside the reserved /-/ namespace;
 * inside it the hub lives at the prefix directly. Static, so it outranks /metrics/$slug.
 */
export const Route = createFileRoute("/metrics/explained")({
	beforeLoad: () => {
		throw redirect({ to: "/-/metrics", statusCode: 301 });
	},
});
