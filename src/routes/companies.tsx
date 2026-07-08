import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BadgeCheck } from "lucide-react";
import { useState } from "react";
import { type CompanyLeaderEntry, getCompanyLeaderboard } from "#/lib/org";

/**
 * The company leaderboard: GitHub orgs ranked by their public members' lifetime commits *to
 * that org* (org-scoped, so a member's unrelated side projects don't count). Deliberately a
 * standalone route rather than a mode of the home Leaderboard — that component is coupled to
 * user metrics and sponsor-row interleaving. The search form here is how new companies enter
 * the board: it navigates to /$login (logins are one namespace on GitHub, so the user route
 * resolves orgs too), which builds the org on first visit.
 */

// v1 serves a single page — plenty while the board populates. Swap for the
// LEADERBOARD_PAGE_STOPS infinite-scroll pattern when it outgrows this.
const PAGE_SIZE = 100;

export const Route = createFileRoute("/companies")({
	head: () => {
		const title = "Company leaderboard — commit-history";
		const description =
			"GitHub organizations ranked by their members' lifetime commits to the company's repositories.";
		return {
			meta: [
				{ title },
				{ name: "description", content: description },
				{ property: "og:title", content: title },
				{ property: "og:description", content: description },
				{ property: "og:url", content: "https://commit-history.com/companies" },
				{ name: "twitter:title", content: title },
				{ name: "twitter:description", content: description },
			],
			links: [
				{ rel: "canonical", href: "https://commit-history.com/companies" },
			],
		};
	},
	loader: () =>
		getCompanyLeaderboard({ data: { offset: 0, limit: PAGE_SIZE } }),
	component: Companies,
});

function Companies() {
	const rows = Route.useLoaderData();
	return (
		<main className="mx-auto max-w-2xl px-6 py-16">
			<h1 className="text-center font-hand text-5xl sm:text-6xl">Companies</h1>
			<p className="mt-4 text-center text-lg text-muted-foreground">
				GitHub organizations ranked by their members’ commits{" "}
				<span className="accent-text font-medium">to the company’s repos</span>.
			</p>

			<OrgSearch />

			{rows.length > 0 ? (
				<CompanyBoard rows={rows} />
			) : (
				<p className="mt-14 text-center text-sm text-muted-foreground">
					No companies on the board yet — look one up above to add it.
				</p>
			)}

			<p className="mt-14 text-center text-sm text-muted-foreground">
				Looking for individuals?{" "}
				<Link to="/" className="underline hover:text-foreground">
					The developer leaderboard
				</Link>
			</p>
		</main>
	);
}

/** Mirrors the home search form, but for orgs — submits to /$login (the ingestion point). */
function OrgSearch() {
	const navigate = useNavigate();
	const [login, setLogin] = useState("");

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const org = login.trim();
		if (org) navigate({ to: "/$user", params: { user: org } });
	}

	return (
		<form onSubmit={submit} className="mt-10 flex items-stretch gap-2">
			<div className="flex min-w-0 flex-1 items-center rounded-md border shadow-inner focus-within:shadow-[0_0_0_0.125em_var(--ring)]">
				<span className="pl-3 text-muted-foreground">github.com/</span>
				<input
					value={login}
					onChange={(e) => setLogin(e.target.value)}
					placeholder="paritytech"
					aria-label="GitHub organization"
					className="min-w-0 flex-1 bg-transparent p-2 pl-0 outline-none placeholder:text-muted-foreground/60"
				/>
			</div>
			<button type="submit" className="btn-primary">
				Plot
			</button>
		</form>
	);
}

function CompanyBoard({ rows }: { rows: CompanyLeaderEntry[] }) {
	return (
		<section className="mt-14">
			<div className="sticky top-0 z-20 border-border border-b bg-background pt-3 pb-3">
				<h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xl font-bold tracking-tight">
					All-time
					<span className="font-hand font-normal text-3xl text-primary leading-none">
						Company
					</span>
					leaderboard
				</h2>
				<p className="mt-1.5 text-xs text-muted-foreground">
					Public members’ lifetime commits to the organization’s repositories.
				</p>
			</div>
			<ol>
				{rows.map((org, i) => (
					<li key={org.login} className="border-border border-b">
						<Link
							to="/$user"
							params={{ user: org.login }}
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
								src={org.avatarUrl ?? ""}
								alt=""
								className="h-8 w-8 rounded-lg border border-border"
							/>
							<span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-medium">
								{org.login}
								{org.isVerified && (
									<BadgeCheck
										className="h-4 w-4 shrink-0 text-primary"
										aria-label="Verified organization"
									/>
								)}
								{org.name && (
									<span className="hidden truncate font-normal text-muted-foreground opacity-0 transition-opacity duration-200 sm:inline desktop:group-hover:opacity-100 desktop:group-focus-within:opacity-100">
										{org.name}
									</span>
								)}
							</span>
							<span className="text-right">
								<span className="block font-semibold tabular-nums">
									{org.totalCommits.toLocaleString()}
								</span>
								<span className="block text-xs text-muted-foreground tabular-nums">
									commits
								</span>
							</span>
						</Link>
					</li>
				))}
			</ol>
		</section>
	);
}
