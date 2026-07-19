import { createFileRoute } from "@tanstack/react-router";
import { getCommitHistory } from "#/lib/cache";
import { renderChartSvg, renderMessageSvg } from "#/lib/chart-svg";
import { GitHubError } from "#/lib/github";

/**
 * Embeddable SVG chart for GitHub READMEs etc:  ![](https://commit-history.com/embed/<user>)
 *
 * A pure server route — `server.handlers.GET` returns raw image/svg+xml (no React component).
 * The SVG inlines its font + filter so it renders standalone in GitHub's <img> sandbox.
 */
export const Route = createFileRoute("/embed/$user")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const theme =
					new URL(request.url).searchParams.get("theme") === "dark"
						? "dark"
						: "light";
				const token = process.env.GITHUB_TOKEN ?? "";

				try {
					// Embed fetches are README badges / CDN cache misses, not searches — serve
					// (and build/refresh) the data but never count them as lookups.
					const history = await getCommitHistory(params.user, token, {
						record: false,
					});
					return new Response(renderChartSvg(history, theme), {
						headers: {
							"content-type": "image/svg+xml; charset=utf-8",
							// Badge image, not a page — keep it (and its ?theme= variants) out of the
							// search index so it never competes with the /$user profile page.
							"x-robots-tag": "noindex",
							// Long-ish cache: our data is monthly and the cache layer keeps it fresh.
							"cache-control": "public, max-age=3600, s-maxage=3600",
							// `durable` = one shared cache entry across all Netlify edge nodes instead of
							// one per node, so Camo traffic stops invoking the function. Netlify-only
							// header; other CDNs/servers ignore it.
							"netlify-cdn-cache-control":
								"public, durable, s-maxage=3600, stale-while-revalidate=86400",
						},
					});
				} catch (e) {
					const message =
						e instanceof GitHubError ? e.message : "Something went wrong";
					// Return 200 with a message card so the embed shows a graceful image, not broken.
					return new Response(renderMessageSvg(message, theme), {
						headers: {
							"content-type": "image/svg+xml; charset=utf-8",
							"x-robots-tag": "noindex",
							"cache-control": "public, max-age=60",
							// Short durable cache so a rate-limit storm doesn't hammer the function,
							// while real data still replaces the message card quickly.
							"netlify-cdn-cache-control":
								"public, durable, s-maxage=60, stale-while-revalidate=300",
						},
					});
				}
			},
		},
	},
});
