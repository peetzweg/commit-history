import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { RepoMonthlyBars } from "#/components/RepoMonthlyBars";
import { fmt, fmtLowerBound, relativeAge } from "#/lib/repo-format";
import { isStatsTruncated } from "#/lib/repo-metrics";
import { getRepository, type RepoMonthRow } from "#/lib/repositories";

/**
 * One repository's numbers and monthly history (#212 prototype), at the repository's own GitHub
 * path: /paritytech/polkadot-sdk. The trailing underscore in the file name (`$user_`) keeps this
 * route out of the /$user layout, so it is a sibling of the profile page, not a child of it.
 *
 * Only repositories already tracked render; anything else is a 404 without a GitHub request, so
 * two-segment scanner probes (/wp-admin/setup.php, …) cost one indexed read. Static two-segment
 * routes (/embed/…, /metrics/…, /og/…) outrank this dynamic one, which shadows repositories of
 * accounts with those logins, the same trade-off the reserved words already make for /$user.
 */
export const Route = createFileRoute("/$user_/$repo")({
	loader: async ({ params }) => {
		const detail = await getRepository({
			data: { owner: params.user, name: params.repo },
		});
		if (!detail) throw notFound();
		return detail;
	},
	head: ({ params }) => ({
		meta: [
			{ title: `${params.user}/${params.repo} — repository stats` },
			// Prototype: kept out of search until repositories are tracked in production.
			{ name: "robots", content: "noindex" },
		],
	}),
	component: RepoPage,
});

function Stat({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint?: string;
}) {
	return (
		<div className="rounded-xl border border-border p-3">
			<div className="text-xl font-semibold tabular-nums">{value}</div>
			<div className="text-xs text-muted-foreground">{label}</div>
			{hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
		</div>
	);
}

function RepoPage() {
	const { repo, monthly } = Route.useLoaderData();
	const series = (pick: (m: RepoMonthRow) => number | null) =>
		monthly.map((m) => ({ month: m.month, value: pick(m) }));
	const truncated = isStatsTruncated(
		repo.contributorStatsRows,
		repo.contributors,
	);
	const statsStale =
		!repo.statsFetchedAt || repo.statsTipSha !== repo.defaultBranchTipSha;

	return (
		<main className="mx-auto max-w-5xl px-6 py-12">
			<Link
				to="/"
				search={{ kind: "repo" }}
				className="text-sm text-muted-foreground hover:text-foreground"
			>
				← repository leaderboard
			</Link>

			<header className="mt-6 flex items-start gap-4">
				{repo.ownerAvatarUrl && (
					<img
						src={`${repo.ownerAvatarUrl}&s=96`}
						alt=""
						width={48}
						height={48}
						className="h-12 w-12 rounded-lg border border-border"
					/>
				)}
				<div className="min-w-0">
					<h1 className="text-3xl font-bold leading-tight break-words">
						<a
							href={`https://github.com/${repo.owner}/${repo.name}`}
							className="hover:underline"
						>
							{repo.owner}/{repo.name}
						</a>
					</h1>
					{repo.description && (
						<p className="mt-2 text-muted-foreground">{repo.description}</p>
					)}
					<p className="mt-2 text-xs text-muted-foreground">
						{[
							repo.primaryLanguage,
							repo.license,
							repo.isArchived ? "archived" : null,
							repo.defaultBranch &&
								`default branch ${repo.defaultBranch} @ ${repo.defaultBranchTipSha?.slice(0, 7)}`,
							repo.pushedAt && `last push ${relativeAge(repo.pushedAt)}`,
						]
							.filter(Boolean)
							.join(" · ")}
					</p>
				</div>
			</header>

			{repo.unreachableAt && (
				<p className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm">
					GitHub stopped resolving this repository{" "}
					{relativeAge(repo.unreachableAt)}. The numbers below are the last we
					read.
				</p>
			)}

			<section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat label="stars" value={fmt(repo.stars)} />
				<Stat label="forks" value={fmt(repo.forks)} />
				<Stat label="watchers" value={fmt(repo.watchers)} />
				<Stat label="releases" value={fmt(repo.releases)} />
				<Stat
					label="commits on default branch"
					value={fmt(repo.commits)}
					hint={`${fmt(repo.commitsLastYear)} in the last 12 months`}
				/>
				<Stat
					label="contributors"
					value={fmt(repo.contributors)}
					hint={`${fmtLowerBound(repo.activeContributorsLastYear, truncated)} active in 12 mo · ${fmt(repo.anonymousContributors)} not linked to an account`}
				/>
				<Stat
					label="bus factor"
					value={fmt(repo.busFactor)}
					hint="fewest contributors with ≥50% of commits"
				/>
				<Stat
					label="PRs merged"
					value={fmt(repo.mergedPullRequests)}
					hint={`${fmt(repo.openPullRequests)} open · ${fmt(repo.closedPullRequests)} closed unmerged`}
				/>
				<Stat
					label="open issues"
					value={fmt(repo.openIssues)}
					hint={`${fmt(repo.closedIssues)} closed`}
				/>
			</section>

			<p className="mt-4 text-xs text-muted-foreground">
				Snapshot read {relativeAge(repo.metricsFetchedAt)}. Contributor
				statistics{" "}
				{repo.statsFetchedAt
					? `computed ${relativeAge(repo.statsFetchedAt)}`
					: "not computed by GitHub yet"}
				{statsStale && repo.statsFetchedAt
					? ", for an older branch tip, so they may trail the commit count."
					: "."}
			</p>

			<h2 className="mt-12 text-xl font-semibold">Monthly history</h2>
			<p className="mt-1 text-sm text-muted-foreground">
				Completed months only, back-filled from GitHub to the first commit.
			</p>
			<div className="mt-4 grid gap-4 md:grid-cols-2">
				<RepoMonthlyBars
					title="Commits on default branch"
					points={series((m) => m.commits)}
				/>
				<RepoMonthlyBars
					title="Active contributors"
					points={series((m) => m.activeContributors)}
					note={`Weeks are assigned to the month they start in.${truncated ? ` GitHub's statistics cover only the top ${repo.contributorStatsRows} contributors here, so these are lower bounds.` : ""}`}
				/>
				<RepoMonthlyBars
					title="New contributors"
					points={series((m) => m.newContributors)}
					note={
						truncated
							? `First commit month of the top ${repo.contributorStatsRows} contributors only. Newcomers outside them are missing.`
							: "Month of each contributor's first counted commit."
					}
				/>
				<RepoMonthlyBars
					title="New stars"
					points={series((m) => m.starsGained)}
					note={
						repo.starsBackfilledAt
							? undefined
							: "Star history is skipped for very large repositories."
					}
				/>
				<RepoMonthlyBars
					title="Pull requests merged"
					points={series((m) => m.pullRequestsMerged)}
				/>
				<RepoMonthlyBars
					title="Pull requests opened"
					points={series((m) => m.pullRequestsOpened)}
				/>
				<RepoMonthlyBars
					title="Issues opened"
					points={series((m) => m.issuesOpened)}
				/>
				<RepoMonthlyBars
					title="Issues closed"
					points={series((m) => m.issuesClosed)}
				/>
			</div>
		</main>
	);
}
