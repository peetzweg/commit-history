import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { getContext } from "./integrations/tanstack-query/root-provider";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const context = getContext();

	const router = createTanStackRouter({
		routeTree,
		context,
		scrollRestoration: true,
		// Wrap page navigations in the View Transitions API so the floating metric bar (tagged with
		// `view-transition-name: metric-bar`) morphs — shrinking/expanding — across routes instead of
		// unmounting and re-entering. The page itself swaps instantly (the root transition is disabled
		// in CSS); metric-only navigations opt out via `viewTransition: false` so the live thumb still
		// animates. No-ops in browsers without the API.
		defaultViewTransition: true,
		defaultPreload: "intent",
		// Commit histories change ~monthly, so treat loaded data as fresh for the
		// whole session: revisiting a user (or a comparison) is instant, no refetch.
		// A real "revisit" is a fresh page load, which starts a new in-memory cache.
		defaultStaleTime: Infinity,
		// Preloaded-on-intent data is fresh too, so the hover-preload is actually
		// reused on click instead of being re-fetched.
		defaultPreloadStaleTime: Infinity,
		// Keep cached loader data around long enough that browsing away and back
		// stays instant (default gcTime is 30 min).
		defaultGcTime: 1000 * 60 * 60,
	});

	setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient });

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
