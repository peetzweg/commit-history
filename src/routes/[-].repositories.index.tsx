import { createFileRoute, Link } from "@tanstack/react-router";
import { fmt, fmtLowerBound } from "#/lib/repo-format";
import { isStatsTruncated } from "#/lib/repo-metrics";
import {
	getRepoLeaderboard,
	isRepoMetric,
	REPO_METRIC_LABEL,
	REPO_METRICS,
	type RepoLeaderEntry,
	type RepoMetric,
} from "#/lib/repositories";
import { cn } from "#/lib/utils";

/**
 * Repository leaderboard prototype (#212). Lives under the reserved /-/ namespace so it can never
 * shadow a login. Not linked from anywhere and marked noindex while it only runs against the
 * development database.
 */

interface RepoSearch {
	sort?: RepoMetric;
}

export const Route = createFileRoute("/-/repositories/")({
	validateSearch: (search: Record<string, unknown>): RepoSearch =>
		isRepoMetric(search.sort) ? { sort: search.sort } : {},
	loaderDeps: ({ search }) => ({ sort: search.sort ?? "stars" }),
	loader: ({ deps }) => getRepoLeaderboard({ data: { metric: deps.sort } }),
	head: () => ({
		meta: [
			{ title: "Repository leaderboard · Commit History" },
			{ name: "robots", content: "noindex" },
		],
	}),
	component: RepoLeaderboardPage,
});

function RepoLeaderboardPage() {
	const rows = Route.useLoaderData();
	const { sort = "stars" } = Route.useSearch();

	return (
		<main className="mx-auto max-w-5xl px-6 py-12">
			<Link
				to="/"
				className="text-sm text-muted-foreground hover:text-foreground"
			>
				← commit history
			</Link>
			<h1 className="mt-6 text-3xl font-bold leading-tight">
				Repository leaderboard
			</h1>
			<p className="mt-3 text-muted-foreground">
				Open-source GitHub repositories ranked by activity and popularity. Raw
				counts only, no blended score. Every number is defined at the bottom of
				this page.
			</p>

			<nav aria-label="Sort by" className="mt-8 flex flex-wrap gap-2 text-sm">
				{REPO_METRICS.map((m) => (
					<Link
						key={m}
						to="/-/repositories"
						search={{ sort: m === "stars" ? undefined : m }}
						className={cn(
							"rounded-full border border-border px-3 py-1",
							m === sort ? "bg-foreground text-background" : "hover:bg-muted",
						)}
					>
						{REPO_METRIC_LABEL[m]}
					</Link>
				))}
			</nav>

			{rows.length === 0 ? (
				<p className="mt-10 text-muted-foreground">
					No repositories tracked yet. Run{" "}
					<code>scripts/refresh-repos.ts owner/name</code> against this
					database.
				</p>
			) : (
				<ol className="mt-6 overflow-hidden rounded-xl border border-border">
					{rows.map((r, i) => (
						<Row key={r.id} rank={i + 1} repo={r} sort={sort} />
					))}
				</ol>
			)}

			<Definitions />
		</main>
	);
}

const COLUMNS: Array<{ key: RepoMetric; short: string }> = [
	{ key: "stars", short: "stars" },
	{ key: "forks", short: "forks" },
	{ key: "commits", short: "commits" },
	{ key: "contributors", short: "contributors" },
	{ key: "activeContributorsLastYear", short: "active 12 mo" },
	{ key: "prsMergedLastYear", short: "PRs merged 12 mo" },
];

/** The six shown columns, always including the one being ranked by (first, if it isn't a default). */
function columnsFor(sort: RepoMetric) {
	if (COLUMNS.some((c) => c.key === sort)) return COLUMNS;
	return [
		{ key: sort, short: REPO_METRIC_LABEL[sort].toLowerCase() },
		...COLUMNS.slice(0, 5),
	];
}

function Row({
	rank,
	repo,
	sort,
}: {
	rank: number;
	repo: RepoLeaderEntry;
	sort: RepoMetric;
}) {
	const statsPending = !repo.statsFetchedAt;
	return (
		<li className="min-w-0 border-border border-b last:border-b-0">
			<Link
				to="/-/repositories/$owner/$repo"
				params={{ owner: repo.owner, repo: repo.name }}
				className="flex min-w-0 flex-col gap-2 px-3 py-3 hover:bg-muted sm:flex-row sm:items-center"
			>
				<span className="flex w-full min-w-0 flex-1 items-center gap-3">
					<span className="w-6 shrink-0 text-center text-sm tabular-nums text-muted-foreground">
						{rank}
					</span>
					{repo.ownerAvatarUrl && (
						<img
							src={`${repo.ownerAvatarUrl}&s=64`}
							alt=""
							width={32}
							height={32}
							loading="lazy"
							className="h-8 w-8 shrink-0 rounded-md border border-border bg-muted"
						/>
					)}
					<span className="min-w-0">
						<span className="block truncate font-medium">
							{repo.owner}/{repo.name}
							{repo.isArchived && (
								<span className="ml-2 rounded border border-border px-1 text-xs text-muted-foreground">
									archived
								</span>
							)}
						</span>
						<span className="block truncate text-xs text-muted-foreground">
							{[repo.primaryLanguage, repo.description]
								.filter(Boolean)
								.join(" · ")}
						</span>
					</span>
				</span>
				<span className="grid shrink-0 grid-cols-3 gap-x-4 gap-y-1 pl-9 text-right text-xs sm:grid-cols-6 sm:pl-0">
					{columnsFor(sort).map((c) => (
						<span key={c.key} className="min-w-0 sm:min-w-16">
							<span
								className={cn(
									"block tabular-nums",
									c.key === sort
										? "text-base font-semibold"
										: "text-sm text-muted-foreground",
								)}
							>
								{c.key === "activeContributorsLastYear"
									? fmtLowerBound(
											repo[c.key],
											isStatsTruncated(
												repo.contributorStatsRows,
												repo.contributors,
											),
										)
									: fmt(repo[c.key])}
								{statsPending && c.key === "activeContributorsLastYear" && "*"}
							</span>
							<span className="block text-muted-foreground">{c.short}</span>
						</span>
					))}
				</span>
			</Link>
		</li>
	);
}

function Definitions() {
	return (
		<section className="prose prose-neutral mt-12 max-w-none text-sm">
			<h2 className="text-lg">What the numbers mean</h2>
			<dl>
				<dt>Commits</dt>
				<dd>
					Commits reachable from the tip of the repository's default branch,
					which is read from GitHub (never assumed to be <code>main</code>).
					Merge commits count. A force-push can lower it.
				</dd>
				<dt>Commits (12 mo)</dt>
				<dd>The same history, limited to the trailing 365 days.</dd>
				<dt>Contributors</dt>
				<dd>
					Distinct commit authors GitHub lists for the repository, including
					authors whose email is not linked to a GitHub account. GitHub refuses
					to list contributors for the very largest histories (the Linux
					kernel); those show "—".
				</dd>
				<dt>Active contributors (12 mo)</dt>
				<dd>
					Contributors with at least one commit in the last 52 weeks, from
					GitHub's contributor statistics. Those leave out merge and empty
					commits and often cover only the top contributors (as few as 100), so
					a <code>≥</code> marks a lower bound. GitHub computes them in the
					background; a <code>*</code> marks numbers waiting on a fresh
					computation.
				</dd>
				<dt>Merged PRs (12 mo), new stars (12 mo)</dt>
				<dd>
					Sums over the last 12 completed months. Stars come from each
					stargazer's timestamp, so unstarred stars are not counted. Very large
					repositories skip the star history; they show "—".
				</dd>
			</dl>
		</section>
	);
}
