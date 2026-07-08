import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BadgeCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ExplainerLink } from "#/components/ExplainerLink";
import {
	getLeaderboard,
	getRecentLookups,
	getStartPageData,
	LEADERBOARD_PAGE_STOPS,
	type LeaderEntry,
	type LeaderMode,
	type RecentEntry,
} from "#/lib/commit-history";
import { type CompanyLeaderEntry, getCompanyLeaderboard } from "#/lib/org";
import { cn } from "#/lib/utils";

// Leaderboard metrics that live in the URL as `?metric=…`. "public" (commits) is the default and
// is omitted so the common case stays a clean, copy-pasteable URL.
const LB_METRIC_PARAMS: readonly LeaderMode[] = [
	"prs",
	"issues",
	"reviews",
	"repos",
	"private",
	"total",
	"followers",
];

function isLeaderMetricParam(v: unknown): v is LeaderMode {
	return typeof v === "string" && (LB_METRIC_PARAMS as string[]).includes(v);
}

interface HomeSearch {
	/** Selected leaderboard metric; absent = the default (commits). */
	metric?: LeaderMode;
	/** Which board is shown; absent = developers, "org" = the company board. */
	kind?: "org";
}

// Company board page size — a single page for now (the board is young); swap for the
// LEADERBOARD_PAGE_STOPS infinite-scroll pattern when it outgrows this.
const COMPANY_PAGE_SIZE = 100;

export const Route = createFileRoute("/")({
	// `?metric=` selects the leaderboard type so a view can be shared; invalid/absent → commits.
	// `?kind=org` flips the board to companies (same clean-URL convention: default is absent).
	validateSearch: (search: Record<string, unknown>): HomeSearch => ({
		...(isLeaderMetricParam(search.metric) ? { metric: search.metric } : {}),
		...(search.kind === "org" ? { kind: "org" as const } : {}),
	}),
	head: () => ({
		links: [{ rel: "canonical", href: "https://commit-history.com/" }],
	}),
	// The board kind changes what the loader fetches, so it's a loader dep — toggling re-runs it.
	loaderDeps: ({ search }) => ({ kind: search.kind }),
	loader: async ({ deps }) => {
		if (deps.kind === "org") {
			const [recent, companies] = await Promise.all([
				getRecentLookups(),
				getCompanyLeaderboard({
					data: { offset: 0, limit: COMPANY_PAGE_SIZE },
				}),
			]);
			return { recent, leaderboard: [] as LeaderEntry[], companies };
		}
		const start = await getStartPageData();
		return { ...start, companies: [] as CompanyLeaderEntry[] };
	},
	component: Home,
});

function Home() {
	const navigate = useNavigate();
	const initial = Route.useLoaderData();
	const { kind } = Route.useSearch();
	// Live "Recently looked up": poll every 16s, seeded by the SSR loader. Kept deliberately
	// gentle to stay easy on the server-function call budget.
	const { data: recent } = useQuery({
		queryKey: ["recent"],
		queryFn: () => getRecentLookups(),
		initialData: initial.recent,
		refetchInterval: 16_000,
	});
	const [login, setLogin] = useState("");

	// Autofocus the username input on desktop only. Same media query as the CSS `desktop:`
	// variant (styles.css) — on touch devices focusing would pop the keyboard over half the page.
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (window.matchMedia("(hover: hover)").matches) {
			inputRef.current?.focus();
		}
	}, []);

	function go(user: string) {
		navigate({ to: "/$user", params: { user } });
	}
	function submit(e: React.FormEvent) {
		e.preventDefault();
		const user = login.trim();
		if (user) go(user);
	}

	return (
		<main className="mx-auto max-w-2xl px-6 py-16">
			<h1 className="text-center font-hand text-5xl sm:text-6xl">
				Commit History
			</h1>
			<p className="mt-4 text-center text-lg text-muted-foreground">
				A <span className="accent-text font-medium">star-history</span>, but for
				a GitHub user’s cumulative commits over their whole lifetime.
			</p>

			<form onSubmit={submit} className="mt-10 flex items-stretch gap-2">
				<div className="flex min-w-0 flex-1 items-center rounded-md border shadow-inner focus-within:shadow-[0_0_0_0.125em_var(--ring)]">
					<span className="pl-3 text-muted-foreground">github.com/</span>
					<input
						ref={inputRef}
						value={login}
						onChange={(e) => setLogin(e.target.value)}
						placeholder="peetzweg"
						aria-label="GitHub username"
						className="min-w-0 flex-1 bg-transparent p-2 pl-0 outline-none placeholder:text-muted-foreground/60"
					/>
				</div>
				<button type="submit" className="btn-primary">
					Plot
				</button>
			</form>

			{recent.length > 0 && <RecentSection recent={recent} />}
			<div className="mt-14 flex justify-center">
				<BoardKindToggle />
			</div>
			{kind === "org" ? (
				<CompanyBoard rows={initial.companies} />
			) : (
				initial.leaderboard.length > 0 && (
					<Leaderboard initialPage={initial.leaderboard} />
				)
			)}
			<p className="mt-14 text-center text-sm text-muted-foreground">
				Wondering what these numbers mean?{" "}
				<Link
					to="/metrics/explained"
					className="underline hover:text-foreground"
				>
					The metrics, explained
				</Link>
			</p>
		</main>
	);
}

/**
 * Centered tab bar above the leaderboard heading, switching between the developer and company
 * boards via `?kind=`. Switching also drops `?metric=` — the company board ranks by commits
 * only (per-metric company boards can follow), so a stale metric param would be meaningless.
 */
function BoardKindToggle() {
	const { kind } = Route.useSearch();
	const navigate = useNavigate();
	const set = (next: "user" | "org") =>
		navigate({
			to: ".",
			search: (prev) => ({
				...prev,
				kind: next === "org" ? ("org" as const) : undefined,
				metric: undefined,
			}),
			replace: true,
			resetScroll: false,
		});
	return (
		<div className="inline-flex overflow-hidden rounded-md border text-sm">
			{(
				[
					["user", "Developers"],
					["org", "Companies"],
				] as const
			).map(([k, label]) => (
				<button
					key={k}
					type="button"
					aria-pressed={(kind ?? "user") === k}
					onClick={() => set(k)}
					className={
						(kind ?? "user") === k
							? "bg-foreground px-4 leading-9 text-background"
							: "px-4 leading-9 text-muted-foreground hover:bg-muted"
					}
				>
					{label}
				</button>
			))}
		</div>
	);
}

function SectionHeading({ children }: { children: React.ReactNode }) {
	return (
		<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			{children}
		</h2>
	);
}

function RecentSection({ recent }: { recent: RecentEntry[] }) {
	return (
		<section className="mt-14">
			<SectionHeading>Recently looked up</SectionHeading>
			<div className="group/chips mt-4 flex flex-wrap gap-2">
				<AnimatePresence initial={false} mode="popLayout">
					{recent.map((u, i) => (
						<motion.div
							key={u.login}
							layout
							initial={{ opacity: 0, scale: 0.8 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0, scale: 0.8 }}
							transition={{ type: "spring", stiffness: 500, damping: 32 }}
							// Lift the whole chip above its neighbours while its name is
							// revealed, so the overflowing pill isn't painted under the next one.
							// Beyond the 8th chip we only show on desktop (sm+); phones keep the
							// list to a tidy eight.
							className={cn(
								"relative desktop:has-[a:hover]:z-10 desktop:has-[a:focus-within]:z-10",
								i >= 8 && "hidden sm:block",
							)}
						>
							{/* Sizer holds the collapsed footprint so the row layout never
							    reflows on hover (which would wrap the chip and cause a
							    hover→collapse→hover flicker). The real chip is absolutely
							    positioned on top and free to grow rightward over its neighbour. */}
							<div className="relative transition duration-200 desktop:group-has-[a:hover]/chips:opacity-60 desktop:group-has-[a:hover]/chips:blur-[2px] desktop:group-has-[a:focus-within]/chips:opacity-60 desktop:group-has-[a:focus-within]/chips:blur-[2px] desktop:has-[a:hover]:opacity-100! desktop:has-[a:hover]:blur-none! desktop:has-[a:focus-within]:opacity-100! desktop:has-[a:focus-within]:blur-none!">
								<span
									aria-hidden
									className="pointer-events-none invisible flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm"
								>
									<span className="h-6 w-6 rounded-full border border-border" />
									{u.login}
								</span>
								<Link
									to="/$user"
									params={{ user: u.login }}
									preload={false}
									className="group absolute inset-y-0 left-0 flex w-max items-center gap-2 rounded-full border bg-background py-1 pr-3 pl-1 text-sm hover:bg-muted"
								>
									<img
										src={u.avatarUrl ?? ""}
										alt=""
										className="h-6 w-6 rounded-full border border-border"
									/>
									<span className="inline-flex items-center">
										{u.login}
										{u.name && (
											<span className="max-w-0 overflow-hidden whitespace-nowrap text-muted-foreground opacity-0 transition-all duration-200 desktop:group-hover:ml-1 desktop:group-hover:max-w-40 desktop:group-hover:opacity-100 desktop:group-focus-within:ml-1 desktop:group-focus-within:max-w-40 desktop:group-focus-within:opacity-100">
												{u.name}
											</span>
										)}
									</span>
								</Link>
							</div>
						</motion.div>
					))}
				</AnimatePresence>
			</div>
		</section>
	);
}

/**
 * A single hardcoded sponsor row, shown in the slot after rank 5.
 *
 * Same visual treatment as the (parked) DB-driven sponsorship system on `feat/sponsorships`,
 * but with no database — the creative is hardcoded for now. Uses the sponsor's own favicon and
 * page title, and links out with rel="sponsored nofollow".
 */
// A/B test on the Rebates ad subtitle. "a" is the control (original copy), "b" the
// challenger. utm_content carries the variant so clicks are attributable per arm.
const REBATES_VARIANTS = {
	a: {
		subtitle: "The ads in your terminal pay you",
		utmContent: "slot5-test-79-a",
	},
	b: {
		subtitle: "Watch ads while coding. Get paid.",
		utmContent: "slot5-test-79-b",
	},
} as const;

function rebatesHref(utmContent: string): string {
	return `https://rebates.ai/?utm_source=commit-history.com&utm_medium=leaderboard&utm_campaign=commit-history_sponsorship&utm_content=${utmContent}`;
}

function SponsorRow({ ref }: { ref?: React.Ref<HTMLLIElement> }) {
	// Default to the control on the server/first paint so hydration matches, then flip
	// to a random 50/50 arm on the client. Math.random() during render would desync SSR.
	const [variant, setVariant] = useState<"a" | "b">("a");
	useEffect(() => {
		setVariant(Math.random() < 0.5 ? "a" : "b");
	}, []);
	const { subtitle, utmContent } = REBATES_VARIANTS[variant];

	return (
		<motion.li
			ref={ref}
			layout
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ type: "spring", stiffness: 600, damping: 40 }}
			className="border-border border-b bg-muted/40"
		>
			<a
				href={rebatesHref(utmContent)}
				target="_blank"
				rel="sponsored nofollow noopener"
				className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted"
			>
				{/* "Ad" gutter is dropped on mobile to give the title room (it reads cramped otherwise);
				    "Sponsored" on the right keeps the disclosure. */}
				<span className="hidden w-6 items-center justify-center text-[10px] uppercase tracking-wide text-muted-foreground sm:flex">
					Ad
				</span>
				<img
					src="https://rebates.ai/brand/rebates-bandit.svg"
					alt="Rebates.ai"
					className="h-8 w-8 shrink-0 rounded-full border border-border object-cover"
				/>
				{/* Title + tagline on two lines in a lighter weight than the usernames, so the block
				    matches the logo height and doesn't shout as loud as a real leaderboard entry. */}
				<span className="min-w-0 flex-1">
					<span className="block truncate">Rebates.ai</span>
					<span className="block truncate text-xs text-muted-foreground">
						{subtitle}
					</span>
				</span>
				<span className="shrink-0 text-right text-xs text-muted-foreground">
					Sponsored
				</span>
			</a>
		</motion.li>
	);
}

/**
 * A single hardcoded self-promo row, asking readers to support the author.
 *
 * Pure markup — no database, no ads — pointing at the author's GitHub and Ko-fi.
 * Sprinkled through the leaderboard (after slots 50 and 100, and once at the end).
 */
function SelfPromoRow({ ref }: { ref?: React.Ref<HTMLLIElement> }) {
	return (
		<motion.li
			ref={ref}
			layout
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ type: "spring", stiffness: 600, damping: 40 }}
			className="border-border border-b border-dashed bg-muted/40"
		>
			{/* No flex-wrap so it stays one tidy row (it used to break over many lines on mobile). On
			    desktop it mirrors a leaderboard entry — a blank rank slot + the author avatar in line
			    with the others; on mobile both are dropped so the text starts at the row edge. The
			    button is a compact Ko-fi mark + "Support". */}
			<div className="flex w-full items-center gap-3 py-2.5">
				{/* Empty rank slot (desktop only) so the avatar lines up with the ranked rows. */}
				<span className="hidden w-6 shrink-0 sm:block" />
				<img
					src="https://github.com/peetzweg.png"
					alt="peetzweg"
					className="hidden h-8 w-8 shrink-0 rounded-full border border-border sm:block"
				/>
				<p className="min-w-0 flex-1 text-sm text-muted-foreground">
					Do you like this page? Consider supporting me,{" "}
					<Link
						to="/$user"
						params={{ user: "peetzweg" }}
						className="font-medium text-foreground hover:underline"
					>
						peetzweg
					</Link>
					.
				</p>
				<a
					href="https://ko-fi.com/peetzweg"
					target="_blank"
					rel="noopener"
					className="btn-secondary inline-flex shrink-0 items-center gap-1.5 text-xs"
				>
					<img src="/kofi-mark.webp" alt="" className="h-4 w-auto" />
					Support
				</a>
			</div>
		</motion.li>
	);
}

// Singular label for the heading chip ("All-time Commit leaderboard") — reads better as a
// noun-modifier than the plural tab-bar labels.
const HEADING_LABEL: Record<LeaderMode, string> = {
	public: "Commit",
	prs: "PR",
	issues: "Issue",
	reviews: "Review",
	repos: "Repo",
	private: "Private",
	total: "Total",
	followers: "Follower",
};

const LB_VALUE: Record<LeaderMode, (u: LeaderEntry) => number> = {
	public: (u) => u.totalCommits,
	prs: (u) => u.totalPullRequests ?? 0,
	issues: (u) => u.totalIssues ?? 0,
	reviews: (u) => u.totalReviews ?? 0,
	repos: (u) => u.totalRepos ?? 0,
	private: (u) => u.totalRestricted,
	// Every contribution type summed (null type totals coalesced to 0 until backfilled).
	total: (u) =>
		u.totalCommits +
		(u.totalIssues ?? 0) +
		(u.totalPullRequests ?? 0) +
		(u.totalReviews ?? 0) +
		(u.totalRepos ?? 0) +
		u.totalRestricted,
	followers: (u) => u.followers ?? 0,
};

/** Singular-ish unit shown under each row's number, per mode. */
const LB_UNIT: Record<LeaderMode, string> = {
	public: "commits",
	prs: "pull requests",
	issues: "issues",
	reviews: "reviews",
	repos: "repos",
	private: "private",
	total: "contributions",
	followers: "followers",
};

function Leaderboard({ initialPage }: { initialPage: LeaderEntry[] }) {
	// The leaderboard metric lives in `?metric=` (written by the shared MetricBar); we just read it
	// here to rank the list. Commits is the default and stays param-free.
	const { metric } = Route.useSearch();
	const mode = metric ?? "public";
	const value = LB_VALUE[mode];
	// Carry the selected metric into the profile links so a click keeps the current view. Commits is
	// the profile default (clean URL, no param), and followers has no chart, so both omit it.
	const linkMetric =
		mode === "public" || mode === "followers" ? undefined : mode;

	const query = useInfiniteQuery({
		queryKey: ["leaderboard", mode],
		queryFn: ({ pageParam }) =>
			getLeaderboard({
				data: { mode, offset: pageParam.offset, limit: pageParam.limit },
			}),
		initialPageParam: { offset: 0, limit: LEADERBOARD_PAGE_STOPS[0] as number },
		// Reveal rows in widening chunks up to the final stop (the 250 cap). Stop early if the
		// DB returns a short page (table exhausted) or we've reached the last stop.
		getNextPageParam: (_lastPage, allPages) => {
			const loaded = allPages.reduce((n, p) => n + p.length, 0);
			const expected = LEADERBOARD_PAGE_STOPS[allPages.length - 1];
			if (expected !== undefined && loaded < expected) return undefined;
			const nextStop = LEADERBOARD_PAGE_STOPS[allPages.length];
			if (nextStop === undefined) return undefined;
			return { offset: loaded, limit: nextStop - loaded };
		},
		// Seed page 1 of the default (Public) mode from the SSR loader — no flash.
		initialData:
			mode === "public"
				? {
						pages: [initialPage],
						pageParams: [{ offset: 0, limit: LEADERBOARD_PAGE_STOPS[0] }],
					}
				: undefined,
		// No background polling: the board changes slowly. It refetches on mount (navigating
		// back shows new entries immediately) and on window focus, but never while idle.
	});

	// Pages are separate OFFSET queries against a live table: if ranks shift between fetches
	// (a freshly built user slots in mid-scroll), a login can land in two pages. Keep the first
	// occurrence — duplicates would collide as React keys and hide a neighbouring row.
	const seenLogins = new Set<string>();
	const rows = (query.data?.pages.flat() ?? []).filter((r) => {
		if (seenLogins.has(r.login)) return false;
		seenLogins.add(r.login);
		return true;
	});

	// Infinite scroll: load the next page when the sentinel nears the viewport.
	const sentinel = useRef<HTMLDivElement>(null);
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
	useEffect(() => {
		const el = sentinel.current;
		if (!el) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
					fetchNextPage();
				}
			},
			{ rootMargin: "300px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);

	const subtitle = {
		public: "Public commits.",
		prs: "Public pull requests opened.",
		issues: "Public issues opened.",
		reviews: "Public pull-request reviews.",
		repos: "Public repositories created — forks don’t count.",
		private: "Private contributions (only users who expose them).",
		total:
			"Every contribution type — commits, PRs, issues, reviews, repos, plus private.",
		followers: "GitHub followers.",
	}[mode];

	return (
		<section className="mt-6">
			{/* Sticky heading: pins to the top of the window while the list scrolls, so deep in the
			    board you (and any screenshot) still see which metric is ranked. Solid background —
			    no translucency/blur — so passing rows never bleed through a capture. z sits above
			    the row hover/recent-chip layers (z-10) and below the floating metric bar (z-50).
			    The bottom hairline doubles as the list's top border while rows slide under it. */}
			<div className="sticky top-0 z-20 border-border border-b bg-background pt-3 pb-3">
				{/* The selected metric is called out in the hand-drawn font and brand green, right inside
				    the heading, so the title itself shows what you're ranking. */}
				<h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xl font-bold tracking-tight">
					All-time
					<span className="font-hand font-normal text-3xl text-primary leading-none">
						{HEADING_LABEL[mode]}
					</span>
					leaderboard
				</h2>
				<p className="mt-1.5 text-xs text-muted-foreground">
					{subtitle} <ExplainerLink metric={mode} />
				</p>
			</div>
			<ol>
				<AnimatePresence initial={false} mode="popLayout">
					{/* Flattened into one keyed list rather than Fragment-wrapped pairs: popLayout
					    attaches a ref to each direct child to measure it, and a Fragment can't hold a
					    ref (React warns). The interleaved ad/promo rows are keyed motion.li too. */}
					{rows.flatMap((u, i) => {
						const items = [
							<motion.li
								key={u.login}
								layout
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ type: "spring", stiffness: 600, damping: 40 }}
								className="border-border border-b"
							>
								<Link
									to="/$user"
									params={{ user: u.login }}
									search={{ metric: linkMetric }}
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
										src={u.avatarUrl ?? ""}
										alt=""
										className="h-8 w-8 rounded-full border border-border"
									/>
									<span className="flex-1 truncate font-medium">
										{u.login}
										{u.name && (
											<span className="ml-2 hidden font-normal text-muted-foreground opacity-0 transition-opacity duration-200 sm:inline desktop:group-hover:opacity-100 desktop:group-focus-within:opacity-100">
												{u.name}
											</span>
										)}
									</span>
									<span className="text-right">
										<span className="block font-semibold tabular-nums">
											{value(u).toLocaleString()}
										</span>
										<span className="block text-xs text-muted-foreground tabular-nums">
											{LB_UNIT[mode]}
										</span>
									</span>
								</Link>
							</motion.li>,
						];
						// Sponsor sits in the slot after rank 5 (only once there's more below).
						if (i === 4 && rows.length > 5)
							items.push(<SponsorRow key="sponsor" />);
						// Self-promo after slots 10, 50 and 100 (only once there's more below).
						if (i === 9 && rows.length > 10)
							items.push(<SelfPromoRow key="promo-10" />);
						if (i === 49 && rows.length > 50)
							items.push(<SelfPromoRow key="promo-50" />);
						if (i === 99 && rows.length > 100)
							items.push(<SelfPromoRow key="promo-100" />);
						return items;
					})}
				</AnimatePresence>
				{/* Self-promo once the whole leaderboard has finished loading. */}
				{!hasNextPage && !isFetchingNextPage && rows.length > 0 && (
					<SelfPromoRow />
				)}
			</ol>
			<div ref={sentinel} className="h-px" />
			{isFetchingNextPage && (
				<p className="py-3 text-center text-xs text-muted-foreground">
					Loading more…
				</p>
			)}
		</section>
	);
}

/**
 * The company board: orgs ranked by their public members' lifetime commits *to that org*
 * (org-scoped — members' unrelated side projects don't count). Rows come straight from the
 * loader (`?kind=` is a loader dep, so toggling refetches); new companies enter the board via
 * the search box above — /$login resolves orgs too and builds unknown ones on first visit.
 */
function CompanyBoard({ rows }: { rows: CompanyLeaderEntry[] }) {
	if (rows.length === 0) {
		return (
			<p className="mt-8 text-center text-sm text-muted-foreground">
				No companies on the board yet — look up an organization above to add it.
			</p>
		);
	}
	return (
		<section className="mt-6">
			{/* Same sticky-heading treatment as the developer board (see Leaderboard above). */}
			<div className="sticky top-0 z-20 border-border border-b bg-background pt-3 pb-3">
				<h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xl font-bold tracking-tight">
					All-time
					<span className="font-hand font-normal text-3xl text-primary leading-none">
						Company
					</span>
					leaderboard
				</h2>
				<p className="mt-1.5 text-xs text-muted-foreground">
					Public members’ lifetime commits to the organization’s repositories.{" "}
					<Link
						to="/company/$slug"
						params={{ slug: "stats" }}
						className="whitespace-nowrap underline decoration-dotted underline-offset-2 hover:text-foreground"
					>
						What is this?
					</Link>
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
