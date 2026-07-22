import { Link } from "@tanstack/react-router";
import { BadgeCheck } from "lucide-react";
import { motion } from "motion/react";
import { SponsorRow } from "#/components/SponsorRow";
import type { BuildProgress } from "#/lib/github";
import type { OrgMemberEntry, OrgResult } from "#/lib/org";
import type { OrgSummary } from "#/lib/org-cache";

/**
 * Organization views rendered by the /$user route when a login resolves to an organization
 * (GitHub logins share one namespace, so /paritytech IS the org page). Header + lifetime totals
 * of the members' contributions *to this org*, plus the building/error states. No chart yet:
 * orgs have no monthly data until the background worker lands (issue #84 follow-up).
 */

function monthYear(date: string) {
	return new Date(date).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
	});
}

/** Rough, human "14 years ago" / "8 months ago" since a date — mirrors the user page. */
function timeAgo(date: string) {
	const then = new Date(date);
	const now = new Date();
	let years = now.getFullYear() - then.getFullYear();
	const monthDiff = now.getMonth() - then.getMonth();
	if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < then.getDate())) {
		years--;
	}
	if (years >= 1) return `${years} year${years === 1 ? "" : "s"} ago`;
	let months = years * 12 + monthDiff;
	if (now.getDate() < then.getDate()) months--;
	if (months >= 1) return `${months} month${months === 1 ? "" : "s"} ago`;
	return "this month";
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

/** Full-page org result: loaded profile, building progress, or failure — driven by the
 *  /$user loader's org branch and its useBuildPolling state. */
export function OrgResultView({
	result,
	gaveUp,
	retry,
}: {
	result: OrgResult;
	gaveUp: boolean;
	retry: () => void;
}) {
	if (result.org)
		return <LoadedOrg org={result.org} members={result.members} />;

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

	// Valid but too large to build on demand — recorded and queued for the background worker.
	// A gentle notice, not a failure: no Retry (retrying can't help), just "check back later".
	if (result.indexing) {
		return (
			<main className="mx-auto max-w-md px-6 py-24 text-center">
				<h1 className="text-xl font-semibold">
					We’re still indexing {result.login}
				</h1>
				<p className="mt-3 text-sm text-muted-foreground">{result.indexing}</p>
				<div className="mt-6">
					<Link
						to="/"
						className="text-sm text-muted-foreground hover:underline"
					>
						← Try another lookup
					</Link>
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
			{/* Always offer Retry: org builds are resumable, so even a hard GitHub hiccup
			    mid-build continues from the last persisted member. */}
			<button type="button" onClick={retry} className="btn-primary mt-6">
				Retry
			</button>
			<div className="mt-6">
				<Link to="/" className="text-sm text-muted-foreground hover:underline">
					← Try another lookup
				</Link>
			</div>
		</main>
	);
}

function LoadedOrg({
	org,
	members,
}: {
	org: OrgSummary;
	members: OrgMemberEntry[];
}) {
	// Member/repo counts live in the stats row below — the subtitle stays to when and where.
	const facts = [
		`Created ${monthYear(org.createdAt)} (${timeAgo(org.createdAt)})`,
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

			<div className="mx-auto mt-8 grid max-w-xl grid-cols-3 gap-x-4 gap-y-5 text-center sm:mx-0 sm:flex sm:max-w-none sm:flex-wrap sm:gap-10 sm:text-left">
				<Stat label="Commits" value={org.totalCommits.toLocaleString()} />
				<Stat
					label="Pull requests"
					value={org.totalPullRequests.toLocaleString()}
				/>
				<Stat label="Issues" value={org.totalIssues.toLocaleString()} />
				<Stat label="Reviews" value={org.totalReviews.toLocaleString()} />
				<Stat label="Repos" value={org.publicRepos.toLocaleString()} />
				<Stat label="Members" value={org.memberCount.toLocaleString()} />
			</div>

			<p className="mt-8 text-xs text-muted-foreground">
				Lifetime contributions of {org.membersTracked.toLocaleString()} public
				member{org.membersTracked === 1 ? "" : "s"} to {org.login}’s
				repositories, as attributed by GitHub. Private members and private
				contributions aren’t included.{" "}
				<Link
					to="/-/organizations/$slug"
					params={{ slug: "stats" }}
					className="whitespace-nowrap underline decoration-dotted underline-offset-2 hover:text-foreground"
				>
					How is this calculated?
				</Link>
			</p>

			{members.length > 0 && <MemberBoard org={org} members={members} />}
		</main>
	);
}

/** The within-org member leaderboard: public members ranked by commits to this org's repos —
 *  the same rows the headline totals are summed from. Rows link to the member's own page. */
function MemberBoard({
	org,
	members,
}: {
	org: OrgSummary;
	members: OrgMemberEntry[];
}) {
	return (
		<section className="mt-12">
			<div className="border-border border-b pb-3">
				{/* "Current": the roster is a snapshot of today's public members — see the
				    historical-membership issue for keeping departed members' contributions. */}
				<h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xl font-bold tracking-tight">
					Current
					<span className="font-hand font-normal text-3xl text-primary leading-none">
						Members
					</span>
					leaderboard
				</h2>
				<p className="mt-1.5 text-xs text-muted-foreground">
					Public members ranked by their lifetime commits to {org.login}’s
					repositories.{" "}
					<Link
						to="/-/organizations/$slug"
						params={{ slug: "members" }}
						className="whitespace-nowrap underline decoration-dotted underline-offset-2 hover:text-foreground"
					>
						Why am I not on this list?
					</Link>
				</p>
			</div>
			<ol>
				{members.flatMap((m, i) => {
					const items = [
						<li key={m.login} className="border-border border-b">
							<Link
								to="/$user"
								params={{ user: m.login }}
								preload={false}
								className="group flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted"
							>
								<span className="flex w-6 items-center justify-center text-sm tabular-nums text-muted-foreground">
									{i === 0 ? (
										<img
											src="/crown.svg"
											alt="1st place"
											className="h-4 w-auto"
										/>
									) : (
										i + 1
									)}
								</span>
								<img
									src={m.avatarUrl ?? ""}
									alt=""
									className="h-8 w-8 rounded-full border border-border"
								/>
								<span className="min-w-0 flex-1 truncate font-medium">
									{m.login}
									{m.name && (
										<span className="ml-2 hidden font-normal text-muted-foreground opacity-0 transition-opacity duration-200 sm:inline desktop:group-hover:opacity-100 desktop:group-focus-within:opacity-100">
											{m.name}
										</span>
									)}
								</span>
								<span className="text-right">
									<span className="block font-semibold tabular-nums">
										{m.commits.toLocaleString()}
									</span>
									<span className="block text-xs text-muted-foreground tabular-nums">
										commits
									</span>
								</span>
							</Link>
						</li>,
					];
					// The organization sponsor slot rides along on every org's member board too, not
					// just the home org board — same slot, more of the impressions it's sold on. After
					// rank 5, once there's more below.
					if (i === 4 && members.length > 5)
						items.push(<SponsorRow key="sponsor" slot="org" />);
					return items;
				})}
			</ol>
		</section>
	);
}
