import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
	getLeaderboard,
	getRecentLookups,
	getStartPageData,
	LEADERBOARD_PAGE_STOPS,
	type LeaderEntry,
	type LeaderMode,
	type RecentEntry,
} from "#/lib/commit-history";

export const Route = createFileRoute("/")({
	head: () => ({
		links: [{ rel: "canonical", href: "https://commit-history.com/" }],
	}),
	loader: () => getStartPageData(),
	component: Home,
});

function Home() {
	const navigate = useNavigate();
	const initial = Route.useLoaderData();
	// Live "Recently looked up": poll every 16s, seeded by the SSR loader. Kept deliberately
	// gentle to stay easy on the server-function call budget.
	const { data: recent } = useQuery({
		queryKey: ["recent"],
		queryFn: () => getRecentLookups(),
		initialData: initial.recent,
		refetchInterval: 16_000,
	});
	const [login, setLogin] = useState("");

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
			<h1 className="text-center text-5xl font-bold tracking-tight">
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
						// biome-ignore lint/a11y/noAutofocus: single-purpose landing page; focusing the one input is the intent
						autoFocus
						value={login}
						onChange={(e) => setLogin(e.target.value)}
						placeholder="peetzweg"
						aria-label="GitHub username"
						className="min-w-0 flex-1 bg-transparent p-2 pl-1 outline-none"
					/>
				</div>
				<button type="submit" className="btn-primary">
					Plot
				</button>
			</form>

			{recent.length > 0 && <RecentSection recent={recent} onPick={go} />}
			{initial.leaderboard.length > 0 && (
				<Leaderboard initialPage={initial.leaderboard} onPick={go} />
			)}
		</main>
	);
}

function SectionHeading({ children }: { children: React.ReactNode }) {
	return (
		<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			{children}
		</h2>
	);
}

function RecentSection({
	recent,
	onPick,
}: {
	recent: RecentEntry[];
	onPick: (login: string) => void;
}) {
	return (
		<section className="mt-14">
			<SectionHeading>Recently looked up</SectionHeading>
			<div className="mt-4 flex flex-wrap gap-2">
				<AnimatePresence initial={false} mode="popLayout">
					{recent.map((u) => (
						<motion.button
							key={u.login}
							layout
							initial={{ opacity: 0, scale: 0.8 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0, scale: 0.8 }}
							transition={{ type: "spring", stiffness: 500, damping: 32 }}
							type="button"
							onClick={() => onPick(u.login)}
							className="flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm hover:bg-muted"
							title={u.name ?? u.login}
						>
							<img
								src={u.avatarUrl ?? ""}
								alt=""
								className="h-6 w-6 rounded-full border border-border"
							/>
							{u.login}
						</motion.button>
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
function SponsorRow() {
	return (
		<motion.li
			layout
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ type: "spring", stiffness: 600, damping: 40 }}
			className="border-border border-b bg-muted/40"
		>
			<a
				href="https://rebates.ai/?utm_source=commit-history.com&utm_medium=leaderboard&utm_campaign=commit-history_sponsorship&utm_content=slot5"
				target="_blank"
				rel="sponsored nofollow noopener"
				className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted"
			>
				<span className="flex w-6 items-center justify-end text-[10px] uppercase tracking-wide text-muted-foreground">
					Ad
				</span>
				<img
					src="https://rebates.ai/brand/rebates-bandit.svg"
					alt="Rebates"
					className="h-8 w-8 rounded-full border border-border object-cover"
				/>
				<span className="flex-1 truncate font-medium">
					Rebates - The ads in your terminal pay you
				</span>
				<span className="text-right text-xs text-muted-foreground">
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
function SelfPromoRow() {
	return (
		<motion.li
			layout
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ type: "spring", stiffness: 600, damping: 40 }}
			className="border-border border-b border-dashed bg-muted/40"
		>
			<div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
				<span className="flex w-6 shrink-0 items-center justify-center text-base">
					☕
				</span>
				<img
					src="https://github.com/peetzweg.png"
					alt="peetzweg"
					className="h-8 w-8 shrink-0 rounded-full border border-border"
				/>
				<p className="min-w-0 flex-1 text-sm text-muted-foreground">
					Do you like this page?
					<br />
					Consider supporting me,{" "}
					<a
						href="https://github.com/peetzweg"
						target="_blank"
						rel="noreferrer"
						className="font-medium text-foreground hover:underline"
					>
						peetzweg
					</a>
					.
				</p>
				<a
					href="https://ko-fi.com/peetzweg"
					target="_blank"
					rel="noreferrer"
					className="btn-secondary shrink-0 text-xs"
				>
					Buy me a coffee →
				</a>
			</div>
		</motion.li>
	);
}

const LB_VALUE: Record<LeaderMode, (u: LeaderEntry) => number> = {
	public: (u) => u.totalCommits,
	private: (u) => u.totalRestricted,
	both: (u) => u.totalCommits + u.totalRestricted,
	followers: (u) => u.followers ?? 0,
};

function Leaderboard({
	initialPage,
	onPick,
}: {
	initialPage: LeaderEntry[];
	onPick: (login: string) => void;
}) {
	const [mode, setMode] = useState<LeaderMode>("public");
	const value = LB_VALUE[mode];

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

	const rows = query.data?.pages.flat() ?? [];

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

	const subtitle =
		mode === "public"
			? "Public commits."
			: mode === "private"
				? "Private contributions (only users who expose them)."
				: mode === "followers"
					? "GitHub followers."
					: "Total activity — public commits + private contributions.";

	return (
		<section className="mt-14">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<SectionHeading>All-time leaderboard</SectionHeading>
				<LeaderToggle mode={mode} onChange={setMode} />
			</div>
			<p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
			<ol className="mt-4">
				<AnimatePresence initial={false} mode="popLayout">
					{rows.map((u, i) => (
						<Fragment key={u.login}>
							<motion.li
								layout
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ type: "spring", stiffness: 600, damping: 40 }}
								className="border-border border-b"
							>
								<button
									type="button"
									onClick={() => onPick(u.login)}
									className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted"
								>
									<span className="flex w-6 items-center justify-end text-sm tabular-nums text-muted-foreground">
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
									<span className="flex-1 truncate font-medium">{u.login}</span>
									<span className="text-right">
										<span className="block font-semibold tabular-nums">
											{value(u).toLocaleString()}
										</span>
										<span className="block text-xs text-muted-foreground tabular-nums">
											{mode === "private"
												? "private"
												: mode === "public"
													? "commits"
													: mode === "followers"
														? "followers"
														: u.totalRestricted > 0
															? `${u.totalCommits.toLocaleString()} commits · ${u.totalRestricted.toLocaleString()} private`
															: `${u.totalCommits.toLocaleString()} commits`}
										</span>
									</span>
								</button>
							</motion.li>
							{/* Sponsor sits in the slot after rank 5 (only once there's more below). */}
							{i === 4 && rows.length > 5 && <SponsorRow />}
							{/* Self-promo after slots 25, 50 and 100 (only once there's more below). */}
							{i === 24 && rows.length > 25 && <SelfPromoRow />}
							{i === 49 && rows.length > 50 && <SelfPromoRow />}
							{i === 99 && rows.length > 100 && <SelfPromoRow />}
						</Fragment>
					))}
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

const LB_LABELS: Record<LeaderMode, string> = {
	public: "Public",
	private: "Private",
	both: "Both",
	followers: "Followers",
};

function LeaderToggle({
	mode,
	onChange,
}: {
	mode: LeaderMode;
	onChange: (m: LeaderMode) => void;
}) {
	return (
		<div className="flex w-full overflow-hidden rounded-md border text-xs sm:inline-flex sm:w-auto">
			{(["public", "private", "both", "followers"] as const).map((m) => (
				<button
					key={m}
					type="button"
					onClick={() => onChange(m)}
					className={
						mode === m
							? "flex-1 bg-foreground px-3 py-1.5 text-background sm:flex-none"
							: "flex-1 px-3 py-1.5 text-muted-foreground hover:bg-muted sm:flex-none"
					}
				>
					{LB_LABELS[m]}
				</button>
			))}
		</div>
	);
}
