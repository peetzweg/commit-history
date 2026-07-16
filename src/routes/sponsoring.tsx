import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Permanent redirect from the old single-segment /sponsoring URL to its home under the
 * reserved /-/ namespace. The old URL was a deliberate exception to the "single segments
 * belong to the $user route" policy; the namespace move retires that exception.
 */
export const Route = createFileRoute("/sponsoring")({
	beforeLoad: () => {
		throw redirect({ to: "/-/sponsoring", statusCode: 301 });
	},
});
