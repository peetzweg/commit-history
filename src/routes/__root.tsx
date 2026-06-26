import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { Header } from "../components/Header";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

const SITE_URL = "https://commit-history.com";
const TITLE =
	"Commit History — a star-history for a GitHub user’s lifetime commits";
const DESCRIPTION =
	"Visualize any GitHub user’s cumulative commits over their entire lifetime as a chart. Like star-history.com, but for commits.";
const OG_IMAGE = `${SITE_URL}/og.png`;

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ name: "theme-color", content: "#363636" },
			// Open Graph
			{ property: "og:type", content: "website" },
			{ property: "og:site_name", content: "Commit History" },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:url", content: SITE_URL },
			{ property: "og:image", content: OG_IMAGE },
			// Twitter
			{ name: "twitter:card", content: "summary_large_image" },
			{ name: "twitter:title", content: TITLE },
			{ name: "twitter:description", content: DESCRIPTION },
			{ name: "twitter:image", content: OG_IMAGE },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/crown.svg", type: "image/svg+xml" },
			{ rel: "icon", type: "image/png", sizes: "32x32", href: "/crown-32.png" },
			{ rel: "icon", type: "image/png", sizes: "16x16", href: "/crown-16.png" },
			{ rel: "alternate icon", href: "/favicon.ico" },
			{ rel: "apple-touch-icon", href: "/crown-180.png" },
			// NB: canonical is set per-route (here it would duplicate on sub-pages —
			// links aren't deduped across head merges the way meta tags are).
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<Header />
				{children}
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						TanStackQueryDevtools,
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
