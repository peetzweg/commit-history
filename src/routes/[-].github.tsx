import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import {
	type ChartMode,
	CommitChart,
	chartCaption,
	chartTitle,
	cumulativeSeries,
	metricDelta,
} from "#/components/CommitChart";
import { ExplainerLink } from "#/components/ExplainerLink";
import { getGithubHistory } from "#/lib/github-history";
import { METRIC_LABEL } from "#/lib/metrics";

const SITE = "https://commit-history.com";
const URL = `${SITE}/-/github`;
const TITLE = "GitHub activity over time";
const DESCRIPTION =
	"Cumulative GitHub activity, month by month, across every user tracked by Commit History.";

const METRIC_PARAMS: readonly ChartMode[] = [
	"prs",
	"issues",
	"reviews",
	"repos",
	"private",
	"total",
];

function isMetricParam(value: unknown): value is ChartMode {
	return (
		typeof value === "string" && (METRIC_PARAMS as string[]).includes(value)
	);
}

interface GithubSearch {
	metric?: ChartMode;
}

export const Route = createFileRoute("/-/github")({
	validateSearch: (search: Record<string, unknown>): GithubSearch =>
		isMetricParam(search.metric) ? { metric: search.metric } : {},
	loader: () => getGithubHistory(),
	head: () => ({
		meta: [
			{ title: `${TITLE} · Commit History` },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:url", content: URL },
			{ name: "twitter:title", content: TITLE },
			{ name: "twitter:description", content: DESCRIPTION },
		],
		links: [{ rel: "canonical", href: URL }],
	}),
	component: GithubActivity,
});

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-xl font-semibold tabular-nums">{value}</div>
			<div className="text-xs uppercase tracking-wide text-muted-foreground">
				{label}
			</div>
		</div>
	);
}

function GithubActivity() {
	const { points, trackedUsers } = Route.useLoaderData();
	const { metric: mode = "public" } = Route.useSearch();
	const total = cumulativeSeries(points, mode).at(-1) ?? 0;
	const busiest = points.reduce(
		(best, point) =>
			metricDelta(point, mode) > metricDelta(best, mode) ? point : best,
		points[0],
	);
	const title =
		mode === "public" ? "GitHub Commit History" : `GitHub ${chartTitle(mode)}`;

	return (
		<main className="mx-auto max-w-3xl px-6 py-12">
			<Link
				to="/"
				className="text-sm text-muted-foreground hover:text-foreground"
			>
				← commit-history
			</Link>
			<h1 className="mt-6 text-3xl font-bold leading-tight">{TITLE}</h1>
			<p className="mt-3 max-w-2xl text-muted-foreground">{DESCRIPTION}</p>

			{points.length === 0 ? (
				<p className="mt-10 rounded-xl border border-border p-6 text-muted-foreground">
					No tracked monthly activity is available yet.
				</p>
			) : (
				<>
					<div className="mt-8 flex flex-wrap gap-10">
						<Stat label="Tracked users" value={trackedUsers.toLocaleString()} />
						<Stat label={METRIC_LABEL[mode]} value={total.toLocaleString()} />
						<Stat
							label="Busiest month"
							value={`${new Date(busiest.date).toLocaleDateString("en-US", { month: "short", year: "numeric" })} (+${metricDelta(busiest, mode).toLocaleString()})`}
						/>
					</div>
					<motion.div
						initial={{ opacity: 0, filter: "blur(8px)" }}
						animate={{ opacity: 1, filter: "blur(0px)" }}
						transition={{ duration: 0.5 }}
						className="-mx-4 mt-8 pt-5 pb-1.5 sm:mx-0 sm:rounded-xl sm:border sm:border-border sm:p-4"
					>
						<CommitChart points={points} mode={mode} title={title} />
					</motion.div>
					<p className="mt-2 text-xs text-muted-foreground sm:mt-4">
						{chartCaption(mode)} across {trackedUsers.toLocaleString()} users
						tracked by Commit History. <ExplainerLink metric={mode} />
					</p>
				</>
			)}

			<section className="mt-14 border-t border-border pt-8 text-sm text-muted-foreground">
				<h2 className="font-semibold text-foreground">What this includes</h2>
				<p className="mt-2 max-w-2xl">
					Each point is the sum of the completed calendar months stored for
					tracked user profiles. Organizations are excluded so member work is
					never counted twice; profiles under review and unreachable profiles
					remain in the historical total. This is a growing sample of tracked
					GitHub users, not a census of all GitHub activity.
				</p>
			</section>
		</main>
	);
}
