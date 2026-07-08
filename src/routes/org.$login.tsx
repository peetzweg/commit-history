import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { BadgeCheck } from "lucide-react";
import { motion } from "motion/react";
import type { BuildProgress } from "#/lib/github";
import { getOrg } from "#/lib/org";
import type { OrgSummary } from "#/lib/org-cache";
import { useBuildPolling } from "#/lib/use-build-polling";

/**
 * Org ("company") page: profile header + lifetime totals of the members' contributions *to this
 * org*. This route is also the ingestion point — visiting an unknown org starts its build, with
 * the same poll-to-continue contract as user pages. No chart yet: orgs have no monthly data
 * until the background worker lands (issue #84 follow-up).
 */
export const Route = createFileRoute("/org/$login")({
	loader: ({ params }) => getOrg({ data: params.login }),
	head: ({ params }) => {
		const title = `${params.login} — company commit history`;
		const description = `Lifetime GitHub contributions of ${params.login}'s public members to the organization — commits, pull requests, reviews and issues.`;
		const url = `https://commit-history.com/org/${params.login}`;
		return {
			meta: [
				{ title },
				{ name: "description", content: description },
				{ property: "og:title", content: title },
				{ property: "og:description", content: description },
				{ property: "og:url", content: url },
				{ name: "twitter:title", content: title },
				{ name: "twitter:description", content: description },
			],
			links: [{ rel: "canonical", href: url }],
		};
	},
	component: OrgView,
	errorComponent: OrgError,
	pendingComponent: PendingOrg,
	pendingMs: 150,
});

function monthYear(date: string) {
	return new Date(date).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
	});
}

function BackLink() {
	return (
		<Link
			to="/"
			className="text-sm text-muted-foreground hover:text-foreground"
		>
			← commit-history
		</Link>
	);
}

/** Mirrors the loaded header's shape so nothing jumps when data lands (org avatars are square). */
function HeaderSkeleton({ login }: { login: string }) {
	return (
		<header className="mt-6 flex items-center gap-4">
			<div className="h-14 w-14 rounded-xl border border-border bg-muted" />
			<div>
				<h1 className="text-2xl font-bold">&nbsp;</h1>
				<span className="text-sm text-muted-foreground">@{login}</span>
			</div>
		</header>
	);
}

function PendingOrg() {
	const { login } = Route.useParams();
	return (
		<main className="mx-auto max-w-4xl px-6 py-12">
			<BackLink />
			<HeaderSkeleton login={login} />
		</main>
	);
}

function OrgBuildProgressCard({
	login,
	progress,
}: {
	login: string;
	progress: BuildProgress;
}) {
	// The BuildProgress fields read "months" but are plain counters — for orgs they count members.
	const pct =
		progress.monthsTotal > 0
			? Math.min(
					100,
					Math.round((progress.monthsFetched / progress.monthsTotal) * 100),
				)
			: 0;
	return (
		<div className="rounded-xl border border-border p-4 text-left">
			<p className="text-sm font-medium">Building {login}’s numbers…</p>
			<div
				className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-valuenow={pct}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={`Fetching ${login}'s members`}
			>
				<div
					className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
					style={{ width: `${pct}%` }}
				/>
			</div>
			<p
				className="mt-2 text-xs text-muted-foreground tabular-nums"
				aria-live="polite"
			>
				{progress.monthsFetched.toLocaleString()} of{" "}
				{progress.monthsTotal.toLocaleString()} members fetched
			</p>
			<p className="mt-1 text-xs text-muted-foreground">
				We’re adding up each public member’s contributions to the organization —
				hang tight.
			</p>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<motion.div
				key={value}
				initial={{ opacity: 0, y: -4 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.35 }}
				className="text-xl font-semibold tabular-nums"
			>
				{value}
			</motion.div>
			<div className="text-xs uppercase tracking-wide text-muted-foreground">
				{label}
			</div>
		</div>
	);
}

function OrgView() {
	const result = Route.useLoaderData();
	const { login } = Route.useParams();
	const { gaveUp, retry } = useBuildPolling({
		routeId: "/org/$login",
		resetKey: login,
		data: result,
		building: result.building != null,
		fetched: result.building?.monthsFetched ?? 0,
	});

	if (result.org) return <LoadedOrg org={result.org} />;

	if (result.building && !gaveUp) {
		return (
			<main className="mx-auto max-w-4xl px-6 py-12">
				<BackLink />
				<HeaderSkeleton login={result.login} />
				<div className="mx-auto mt-8 grid w-full gap-3 sm:max-w-md">
					<OrgBuildProgressCard
						login={result.login}
						progress={result.building}
					/>
				</div>
			</main>
		);
	}

	// Hard failure, or polling gave up on a stalled build.
	const message = result.error
		? result.error
		: "This build is taking longer than expected — hit Retry to continue it.";
	return (
		<main className="mx-auto max-w-md px-6 py-24 text-center">
			<h1 className="text-xl font-semibold">Couldn’t load that organization</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				<span className="font-medium">{result.login}</span>: {message}
			</p>
			{gaveUp && (
				<button type="button" onClick={retry} className="btn-primary mt-6">
					Retry
				</button>
			)}
			<div className="mt-6">
				<Link to="/" className="text-sm text-muted-foreground hover:underline">
					← Try another lookup
				</Link>
			</div>
		</main>
	);
}

function LoadedOrg({ org }: { org: OrgSummary }) {
	const facts = [
		`Created ${monthYear(org.createdAt)}`,
		`${org.memberCount.toLocaleString()} public member${org.memberCount === 1 ? "" : "s"}`,
		`${org.publicRepos.toLocaleString()} public repos`,
		...(org.location ? [org.location] : []),
	];
	return (
		<main className="mx-auto max-w-4xl px-6 py-12">
			<BackLink />

			<header className="mt-6 flex items-center gap-4">
				<img
					src={org.avatarUrl}
					alt={org.login}
					className="h-20 w-20 rounded-xl border border-border"
				/>
				<div>
					<h1 className="flex items-center gap-2 text-2xl font-bold">
						{org.name ?? org.login}
						{org.isVerified && (
							<BadgeCheck
								className="h-5 w-5 shrink-0 text-primary"
								aria-label="Verified organization"
							/>
						)}
					</h1>
					<a
						href={org.htmlUrl}
						target="_blank"
						rel="noopener"
						className="text-sm text-muted-foreground hover:underline"
					>
						@{org.login}
					</a>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{facts.join(" · ")}
					</p>
				</div>
			</header>

			{org.description && (
				<p className="mt-4 max-w-2xl text-sm text-muted-foreground">
					{org.description}
				</p>
			)}

			<div className="mx-auto mt-8 grid max-w-xl grid-cols-2 gap-x-4 gap-y-5 text-center sm:mx-0 sm:flex sm:max-w-none sm:flex-wrap sm:gap-10 sm:text-left">
				<Stat label="Commits" value={org.totalCommits.toLocaleString()} />
				<Stat
					label="Pull requests"
					value={org.totalPullRequests.toLocaleString()}
				/>
				<Stat label="Reviews" value={org.totalReviews.toLocaleString()} />
				<Stat label="Issues" value={org.totalIssues.toLocaleString()} />
			</div>

			<p className="mt-8 text-xs text-muted-foreground">
				Lifetime contributions of {org.membersTracked.toLocaleString()} public
				member{org.membersTracked === 1 ? "" : "s"} to {org.login}’s
				repositories, as attributed by GitHub. Private members and private
				contributions aren’t included.
			</p>
		</main>
	);
}

function OrgError({ error }: { error: Error }) {
	const router = useRouter();
	return (
		<main className="mx-auto max-w-md px-6 py-24 text-center">
			<h1 className="text-xl font-semibold">Couldn’t load that organization</h1>
			<p className="mt-3 text-sm text-muted-foreground">{error.message}</p>
			<button
				type="button"
				onClick={() => router.invalidate()}
				className="mt-6 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
			>
				Retry
			</button>
			<div className="mt-4">
				<Link to="/" className="text-sm text-muted-foreground hover:underline">
					← Back to search
				</Link>
			</div>
		</main>
	);
}
