import { createFileRoute } from "@tanstack/react-router";
import { type ChartMode, metricDelta } from "#/components/CommitChart";
import {
	isGithubHistoryEnabled,
	queryGithubHistory,
} from "#/lib/github-history";
import { METRIC_NOUN } from "#/lib/metrics";
import { githubCard, renderPng } from "#/lib/og-card";

const PNG_HEADERS = {
	"content-type": "image/png",
	"x-robots-tag": "noindex",
	"cache-control": "public, max-age=3600, s-maxage=3600",
	"netlify-cdn-cache-control":
		"public, durable, s-maxage=3600, stale-while-revalidate=86400",
};

const METRICS: readonly ChartMode[] = [
	"public",
	"prs",
	"issues",
	"reviews",
	"repos",
	"private",
	"total",
];

function metricFrom(request: Request): ChartMode {
	const value = new URL(request.url).searchParams.get("metric");
	return value && (METRICS as string[]).includes(value)
		? (value as ChartMode)
		: "public";
}

/** Dynamic Open Graph card for /-/github, including the selected aggregate metric's live curve. */
export const Route = createFileRoute("/og/github")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!isGithubHistoryEnabled()) {
					return new Response(null, {
						status: 302,
						headers: { location: new URL("/og.png", request.url).toString() },
					});
				}
				const metric = metricFrom(request);
				try {
					const { points, trackedUsers } = await queryGithubHistory();
					const values = points.map((point) => metricDelta(point, metric));
					const total = values.reduce((sum, value) => sum + value, 0);
					const png = await renderPng(
						githubCard({
							metricLabel: METRIC_NOUN[metric],
							total,
							trackedUsers,
							trendValues: values,
						}),
					);
					return new Response(new Uint8Array(png), { headers: PNG_HEADERS });
				} catch {
					return new Response(null, { status: 503, headers: PNG_HEADERS });
				}
			},
		},
	},
});
