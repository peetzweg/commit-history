import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { motion } from "motion/react";
import { useState } from "react";
import {
	type ChartMode,
	CommitChart,
	chartCaption,
} from "#/components/CommitChart";
import {
	type ChartSeries,
	MultiCommitChart,
	SERIES_COLORS,
	type TimelineMode,
} from "#/components/MultiCommitChart";
import {
	getCommitHistories,
	parseLogins,
	type UserResult,
} from "#/lib/commit-history";
import type { CommitPoint } from "#/lib/github";

export const Route = createFileRoute("/$user")({
	loader: ({ params }) =>
		getCommitHistories({ data: parseLogins(params.user) }),
	head: ({ params }) => {
		const logins = parseLogins(params.user);
		const title =
			logins.length > 1
				? `${logins.join(" vs ")} — commit history`
				: `${logins[0] ?? "GitHub user"}’s commit history`;
		const description =
			logins.length > 1
				? `Compare the cumulative GitHub commits of ${logins.join(", ")} over time.`
				: `${logins[0]}’s cumulative GitHub commits over their whole lifetime.`;
		const url = `https://commit-history.com/${logins.join(",")}`;
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
	component: View,
	errorComponent: UserError,
	// Navigate instantly: show the placeholder while the loader runs (skipped for fast cache hits).
	pendingComponent: PendingUser,
	pendingMs: 150,
});

// A generic rising curve, blurred behind the loading state — gives the page real shape while
// the actual data streams in (instead of a shimmering skeleton).
const GENERIC_POINTS: CommitPoint[] = (() => {
	const pts: CommitPoint[] = [];
	let cumulative = 0;
	for (let i = 0; i < 54; i++) {
		const commits = Math.round(15 + i * 1.5 + i ** 1.8 * 0.25);
		cumulative += commits;
		const year = 2021 + Math.floor(i / 12);
		const month = (i % 12) + 1;
		pts.push({
			date: `${year}-${String(month).padStart(2, "0")}-01`,
			commits,
			cumulative,
			restricted: 0,
			restrictedCumulative: 0,
		});
	}
	return pts;
})();

function PendingUser() {
	const { user } = Route.useParams();
	const login = user.split(",")[0];
	const labels = [
		"Public rank",
		"Public commits",
		"Followers",
		"Busiest month",
	];
	return (
		<main className="mx-auto max-w-4xl px-6 py-12">
			<Link
				to="/"
				className="text-sm text-muted-foreground hover:text-foreground"
			>
				← commit-history
			</Link>

			{/* Mirror the loaded layout so nothing jumps: name line reserved above, @login in its
			    final small slot (we already know it from the URL). */}
			<header className="mt-6 flex items-center gap-4">
				<div className="h-14 w-14 rounded-full border border-border bg-muted" />
				<div>
					<h1 className="text-2xl font-bold">&nbsp;</h1>
					<span className="text-sm text-muted-foreground">@{login}</span>
				</div>
			</header>

			<div className="mx-auto mt-8 grid max-w-xl grid-cols-3 gap-x-4 gap-y-5 text-center sm:mx-0 sm:flex sm:max-w-none sm:flex-wrap sm:gap-10 sm:text-left">
				{labels.map((label) => (
					<div key={label}>
						{/* reserve value + hint heights; they animate in once data arrives */}
						<div className="h-7" />
						<div className="text-xs uppercase tracking-wide text-muted-foreground">
							{label}
						</div>
						<div className="h-4" />
					</div>
				))}
			</div>

			<div className="-mx-4 mt-3 pt-5 pb-1.5 sm:mx-0 sm:rounded-xl sm:border sm:border-border sm:p-4">
				<div className="pointer-events-none opacity-40 blur-[6px]">
					<CommitChart points={GENERIC_POINTS} mode="public" />
				</div>
			</div>
		</main>
	);
}

function monthYear(date: string) {
	return new Date(date).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
	});
}

/** Rough, human "14 years ago" / "8 months ago" since a date. */
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

/** Navigate to the route for a given set of logins (single = detailed view, many = comparison). */
function useGoToLogins() {
	const navigate = useNavigate();
	return (logins: string[]) => {
		if (logins.length > 0) {
			navigate({ to: "/$user", params: { user: logins.join(",") } });
		}
	};
}

function View() {
	const results = Route.useLoaderData();
	const ok = results.filter((r) => r.history);
	const failed = results.filter((r) => r.error);
	const logins = results.map((r) => r.login);

	if (ok.length === 0) {
		return (
			<main className="mx-auto max-w-md px-6 py-24 text-center">
				<h1 className="text-xl font-semibold">Couldn’t load that history</h1>
				{failed.map((r) => (
					<p key={r.login} className="mt-3 text-sm text-muted-foreground">
						<span className="font-medium">{r.login}</span>: {r.error}
					</p>
				))}
				<div className="mt-6">
					<Link
						to="/"
						className="text-sm text-muted-foreground hover:underline"
					>
						← Try another user
					</Link>
				</div>
			</main>
		);
	}

	return (
		<main className="mx-auto max-w-4xl px-6 py-12">
			<Link
				to="/"
				className="text-sm text-muted-foreground hover:text-foreground"
			>
				← commit-history
			</Link>
			{ok.length === 1 ? (
				<SingleView result={ok[0]} otherLogins={logins} />
			) : (
				<ComparisonView results={ok} allLogins={logins} />
			)}
			{failed.length > 0 && (
				<p className="mt-4 text-xs text-destructive">
					Couldn’t load:{" "}
					{failed.map((r) => `${r.login} (${r.error})`).join(", ")}
				</p>
			)}
		</main>
	);
}

/** Shown on a suspended profile — public-facing, never reveals the internal reason. */
function SuspendedNotice() {
	return (
		<div className="mt-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
			<p className="font-medium text-amber-700 dark:text-amber-400">
				⚠️ This profile is under review.
			</p>
			<p className="mt-1 text-muted-foreground">
				Its commit history looks suspicious, so it's hidden from the leaderboard
				while we investigate. If this is your account and you think it's a
				mistake, please{" "}
				<a
					href="https://github.com/peetzweg/commit-history/issues"
					target="_blank"
					rel="noopener"
					className="underline hover:text-foreground"
				>
					open an issue
				</a>
				.
			</p>
		</div>
	);
}

// ── Single user: the detailed view ──────────────────────────────────────────

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
		<div>
			<motion.div
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
			{hint && (
				<div className="text-xs tabular-nums text-muted-foreground">{hint}</div>
			)}
		</div>
	);
}

/** Avatar + name + joined line + the headline stats. Shared by the single
 *  view and (stacked) by the comparison view, so profiles look identical. */
function ProfilePanel({
	result,
	color,
}: {
	result: UserResult;
	color?: string;
}) {
	// biome-ignore lint/style/noNonNullAssertion: ok results always have history
	const { user, points, total, totalRestricted } = result.history!;
	const hasPrivate = totalRestricted > 0;
	const since = monthYear(user.createdAt);
	// Public-leaderboard rank — hidden for suspended profiles, which are off the board entirely.
	const rank = result.suspended ? null : result.publicRank;
	// Busiest month by total activity (public + private), so it's meaningful for private-heavy users.
	const busiest = points.reduce(
		(best, p) =>
			p.commits + p.restricted > best.commits + best.restricted ? p : best,
		points[0],
	);

	return (
		<div>
			<header className="flex items-center gap-4">
				<img
					src={user.avatarUrl}
					alt={user.login}
					className="h-20 w-20 rounded-full border border-border"
					style={color ? { borderColor: color, borderWidth: 2 } : undefined}
				/>
				<div>
					<h1 className="flex items-center gap-2 text-2xl font-bold">
						{color && (
							<span
								className="h-2.5 w-2.5 shrink-0 rounded-full"
								style={{ backgroundColor: color }}
							/>
						)}
						{user.name ?? user.login}
					</h1>
					<a
						href={`https://github.com/${user.login}`}
						target="_blank"
						rel="noopener"
						className="text-sm text-muted-foreground hover:underline"
					>
						@{user.login}
					</a>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Joined {since} ({timeAgo(user.createdAt)})
					</p>
				</div>
			</header>

			<div className="mx-auto mt-6 grid max-w-xl grid-cols-3 gap-x-4 gap-y-5 text-center sm:mx-0 sm:flex sm:max-w-none sm:flex-wrap sm:gap-10 sm:text-left">
				{rank !== null && (
					<Stat label="Public rank" value={`#${rank.toLocaleString()}`} />
				)}
				<Stat label="Public commits" value={total.toLocaleString()} />
				{hasPrivate && (
					<Stat
						label="Private contributions"
						value={totalRestricted.toLocaleString()}
					/>
				)}
				<Stat label="Followers" value={user.followers.toLocaleString()} />
				<Stat
					label="Busiest month"
					value={busiest ? monthYear(busiest.date) : "—"}
					hint={
						busiest
							? `${(busiest.commits + busiest.restricted).toLocaleString()} ${hasPrivate ? "contributions" : "commits"}`
							: undefined
					}
				/>
			</div>
		</div>
	);
}

function SingleView({
	result,
	otherLogins,
}: {
	result: UserResult;
	otherLogins: string[];
}) {
	// biome-ignore lint/style/noNonNullAssertion: ok results always have history
	const { user, points, totalRestricted } = result.history!;
	const hasPrivate = totalRestricted > 0;
	const [mode, setMode] = useState<ChartMode>("both");
	const since = monthYear(user.createdAt);

	return (
		<>
			{result.suspended && <SuspendedNotice />}
			<div className="mt-6">
				<ProfilePanel result={result} />
			</div>

			<motion.div
				initial={{ opacity: 0, filter: "blur(8px)" }}
				animate={{ opacity: 1, filter: "blur(0px)" }}
				transition={{ duration: 0.5 }}
				className="-mx-4 mt-8 pt-5 pb-1.5 sm:mx-0 sm:rounded-xl sm:border sm:border-border sm:p-4"
			>
				<CommitChart
					points={points}
					mode={hasPrivate ? mode : "public"}
					label={user.login}
				/>
			</motion.div>

			<div className="mt-2 flex flex-wrap items-center gap-3 sm:mt-4 sm:justify-between">
				<p className="w-full text-xs text-muted-foreground sm:w-auto">
					{chartCaption(hasPrivate ? mode : "public")} attributed by GitHub
					since {since}.
				</p>
				<div className="ml-auto flex flex-col-reverse items-end gap-3 sm:flex-row sm:items-center">
					<AddUser currentLogins={otherLogins} label="Compare with…" />
					{hasPrivate && <ChartModeToggle mode={mode} onChange={setMode} />}
				</div>
			</div>

			<EmbedSnippet login={user.login} />
		</>
	);
}

// ── Embed: a live SVG chart for READMEs ───────────────────────────────────────

const SITE = "https://commit-history.com";

/** The exact markup a user pastes into a README: a centered `<picture>` that
 *  follows GitHub's light/dark mode, wrapping a link back to the user's
 *  commit-history.com page. `align="center"` is the one alignment attribute
 *  GitHub's markdown sanitizer keeps, so it centers on a profile. */
function embedSnippet(login: string): string {
	const page = `${SITE}/${login}`;
	const img = `${SITE}/embed/${login}`;
	const alt = `${login}'s commit history`;
	return `<div align="center">
  <a href="${page}">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="${img}?theme=dark" />
      <img alt="${alt}" src="${img}" />
    </picture>
  </a>
</div>`;
}

function EmbedSnippet({ login }: { login: string }) {
	const [copied, setCopied] = useState(false);
	const snippet = embedSnippet(login);

	async function copy() {
		try {
			await navigator.clipboard.writeText(snippet);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard unavailable */
		}
	}

	return (
		<section className="mt-16 border-t border-border pt-12">
			<h2 className="text-sm font-semibold">Embed in your GitHub profile</h2>
			<p className="mt-1 text-xs text-muted-foreground">
				A live chart that updates over time — drop it into your GitHub profile
				page or any project README. It’s centered and switches between light and
				dark to match the viewer’s GitHub theme.
			</p>

			{/* A static screenshot of the embed on a real profile — we deliberately
			    don't render a live per-user preview here, to avoid a second chart
			    render (and embed request) on every page visit. */}
			<figure className="mt-4">
				<a
					href="https://github.com/peetzweg"
					target="_blank"
					rel="noopener"
					className="block overflow-hidden rounded-xl border border-border"
				>
					<img
						src="/embed-example.png"
						alt="A commit-history chart embedded in a GitHub profile README"
						className="w-full"
						loading="lazy"
					/>
				</a>
				<figcaption className="mt-2 text-xs text-muted-foreground">
					How it looks on a GitHub profile.
				</figcaption>
			</figure>

			<div className="group relative mt-3">
				<pre className="overflow-x-auto rounded-md border bg-muted py-2.5 pl-3 pr-20 text-xs leading-relaxed">
					<code>{snippet}</code>
				</pre>
				<button
					type="button"
					onClick={copy}
					className="absolute right-2 top-2 rounded-md border bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground backdrop-blur transition-colors hover:bg-background hover:text-foreground"
				>
					{copied ? "Copied!" : "Copy"}
				</button>
			</div>
		</section>
	);
}

// ── Multiple users: the comparison view ──────────────────────────────────────

function ComparisonView({
	results,
	allLogins,
}: {
	results: UserResult[];
	allLogins: string[];
}) {
	const [mode, setMode] = useState<TimelineMode>("date");
	const [chartMode, setChartMode] = useState<ChartMode>("both");
	const go = useGoToLogins();

	// Show the public/private/both toggle only when at least one developer exposes
	// private contributions — otherwise "private"/"both" would be identical to "public".
	const anyPrivate = results.some(
		// biome-ignore lint/style/noNonNullAssertion: ok results always have history
		(r) => r.history!.totalRestricted > 0,
	);
	const effectiveChartMode = anyPrivate ? chartMode : "public";

	const series: ChartSeries[] = results.map((r, i) => ({
		login: r.login,
		color: SERIES_COLORS[i % SERIES_COLORS.length],
		// biome-ignore lint/style/noNonNullAssertion: ok results always have history
		points: r.history!.points,
	}));

	// Legend total reflects the selected mode so the numbers match the lines.
	const legendTotal = (r: UserResult) =>
		effectiveChartMode === "public"
			? // biome-ignore lint/style/noNonNullAssertion: ok results always have history
				r.history!.total
			: effectiveChartMode === "private"
				? // biome-ignore lint/style/noNonNullAssertion: ok results always have history
					r.history!.totalRestricted
				: // biome-ignore lint/style/noNonNullAssertion: ok results always have history
					r.history!.total + r.history!.totalRestricted;

	function removeLogin(login: string) {
		go(allLogins.filter((l) => l !== login));
	}

	return (
		<>
			{/* The graph heading now lives inside the chart SVG (hand-drawn, dynamic),
			    matching the single-user view — so here we keep just the comparison caption. */}
			<p className="mt-6 text-sm text-muted-foreground">
				Comparing {series.length} developers
			</p>

			<motion.div
				initial={{ opacity: 0, filter: "blur(8px)" }}
				animate={{ opacity: 1, filter: "blur(0px)" }}
				transition={{ duration: 0.5 }}
				className="-mx-4 mt-6 pt-5 pb-1.5 sm:mx-0 sm:rounded-xl sm:border sm:border-border sm:p-4"
			>
				<MultiCommitChart
					series={series}
					mode={mode}
					chartMode={effectiveChartMode}
				/>
			</motion.div>

			{mode === "aligned" && (
				<p className="mt-3 text-xs text-muted-foreground">
					Aligned: each line starts at its account’s first month, so you compare
					trajectories regardless of when each person joined GitHub.
				</p>
			)}

			<div className="mt-6 flex flex-wrap items-center gap-3">
				{results.map((r, i) => (
					<span
						key={r.login}
						className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm"
					>
						<span
							className="h-2.5 w-2.5 rounded-full"
							style={{
								backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
							}}
						/>
						<a
							href={`https://github.com/${r.login}`}
							target="_blank"
							rel="noopener"
							className="hover:underline"
						>
							{r.login}
						</a>
						<span className="tabular-nums text-muted-foreground">
							{legendTotal(r).toLocaleString()}
						</span>
						<button
							type="button"
							aria-label={`Remove ${r.login}`}
							onClick={() => removeLogin(r.login)}
							className="text-muted-foreground hover:text-destructive"
						>
							×
						</button>
					</span>
				))}
				<div className="ml-auto flex flex-col-reverse items-end gap-3 sm:flex-row sm:items-center">
					<AddUser currentLogins={allLogins} label="Add user…" />
					<div className="flex flex-wrap items-center justify-end gap-2">
						{anyPrivate && (
							<ChartModeToggle mode={chartMode} onChange={setChartMode} />
						)}
						<TimelineToggle mode={mode} onChange={setMode} />
					</div>
				</div>
			</div>

			<section className="mt-12">
				<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Profiles
				</h2>
				<div className="mt-6 flex flex-col divide-y divide-border">
					{results.map((r, i) => (
						<div key={r.login} className="py-6 first:pt-0 last:pb-0">
							<ProfilePanel
								result={r}
								color={SERIES_COLORS[i % SERIES_COLORS.length]}
							/>
							{r.suspended && <SuspendedNotice />}
						</div>
					))}
				</div>
			</section>
		</>
	);
}

function TimelineToggle({
	mode,
	onChange,
}: {
	mode: TimelineMode;
	onChange: (m: TimelineMode) => void;
}) {
	return (
		<div className="inline-flex overflow-hidden rounded-md border text-sm">
			{(["date", "aligned"] as const).map((m) => (
				<button
					key={m}
					type="button"
					onClick={() => onChange(m)}
					className={
						mode === m
							? "bg-foreground px-3 leading-9 text-background"
							: "px-3 leading-9 text-muted-foreground hover:bg-muted"
					}
				>
					{m === "date" ? "Date" : "Aligned"}
				</button>
			))}
		</div>
	);
}

const MODE_LABELS: Record<ChartMode, string> = {
	public: "Public",
	private: "Private",
	both: "All",
};

function ChartModeToggle({
	mode,
	onChange,
}: {
	mode: ChartMode;
	onChange: (m: ChartMode) => void;
}) {
	return (
		<div className="inline-flex overflow-hidden rounded-md border text-sm">
			{(["public", "private", "both"] as const).map((m) => (
				<button
					key={m}
					type="button"
					onClick={() => onChange(m)}
					className={
						mode === m
							? "bg-foreground px-3 leading-9 text-background"
							: "px-3 leading-9 text-muted-foreground hover:bg-muted"
					}
				>
					{MODE_LABELS[m]}
				</button>
			))}
		</div>
	);
}

function AddUser({
	currentLogins,
	label,
}: {
	currentLogins: string[];
	label: string;
}) {
	const [value, setValue] = useState("");
	const go = useGoToLogins();

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const next = value.trim();
		if (next && !currentLogins.includes(next)) {
			go([...currentLogins, next]);
			setValue("");
		}
	}

	return (
		<form onSubmit={submit} className="flex items-stretch gap-2">
			<input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder={label}
				aria-label={label}
				className="w-44 rounded-md border bg-transparent px-3 text-sm shadow-inner outline-none focus:shadow-[0_0_0_0.125em_var(--ring)]"
			/>
			<button type="submit" className="btn-secondary shrink-0">
				Add
			</button>
		</form>
	);
}

function UserError({ error }: { error: Error }) {
	const router = useRouter();
	return (
		<main className="mx-auto max-w-md px-6 py-24 text-center">
			<h1 className="text-xl font-semibold">Couldn’t load that history</h1>
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
					← Try another user
				</Link>
			</div>
		</main>
	);
}
