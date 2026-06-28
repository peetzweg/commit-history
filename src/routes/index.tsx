import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
	getLeaderboard,
	getRecentLookups,
	getStartPageData,
	LEADERBOARD_PAGE_SIZE,
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
	// Live "Recently looked up": poll every 4s, seeded by the SSR loader.
	const { data: recent } = useQuery({
		queryKey: ["recent"],
		queryFn: () => getRecentLookups(),
		initialData: initial.recent,
		refetchInterval: 4_000,
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
				data: { mode, offset: pageParam, limit: LEADERBOARD_PAGE_SIZE },
			}),
		initialPageParam: 0,
		getNextPageParam: (lastPage, allPages) =>
			lastPage.length < LEADERBOARD_PAGE_SIZE
				? undefined
				: allPages.reduce((n, p) => n + p.length, 0),
		// Seed page 1 of the default (Public) mode from the SSR loader — no flash.
		initialData:
			mode === "public" ? { pages: [initialPage], pageParams: [0] } : undefined,
		refetchInterval: 10_000,
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
						<motion.li
							key={u.login}
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
					))}
				</AnimatePresence>
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
