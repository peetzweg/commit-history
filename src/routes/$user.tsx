import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { motion } from "motion/react";
import { useState } from "react";
import { type ChartMode, CommitChart } from "#/components/CommitChart";
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
	const labels = ["Public commits", "Busiest month", "Since"];
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

			<div className="mt-8 flex flex-wrap gap-10">
				{labels.map((label) => (
					<div key={label}>
						{/* reserve value + hint heights; they animate in once data arrives */}
						<div className="h-8" />
						<div className="text-xs uppercase tracking-wide text-muted-foreground">
							{label}
						</div>
						<div className="h-4" />
					</div>
				))}
			</div>

			<div className="mt-3 rounded-xl border border-border p-4">
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
				className="text-2xl font-semibold tabular-nums"
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

function SingleView({
	result,
	otherLogins,
}: {
	result: UserResult;
	otherLogins: string[];
}) {
	// biome-ignore lint/style/noNonNullAssertion: ok results always have history
	const { user, points, total, totalRestricted } = result.history!;
	const hasPrivate = totalRestricted > 0;
	const [mode, setMode] = useState<ChartMode>("both");
	const since = monthYear(user.createdAt);
	// Busiest month by total activity (public + private), so it's meaningful for private-heavy users.
	const busiest = points.reduce(
		(best, p) =>
			p.commits + p.restricted > best.commits + best.restricted ? p : best,
		points[0],
	);

	return (
		<>
			<header className="mt-6 flex items-center gap-4">
				<img
					src={user.avatarUrl}
					alt={user.login}
					className="h-14 w-14 rounded-full border border-border"
				/>
				<div>
					<h1 className="text-2xl font-bold">{user.name ?? user.login}</h1>
					<a
						href={`https://github.com/${user.login}`}
						target="_blank"
						rel="noreferrer"
						className="text-sm text-muted-foreground hover:underline"
					>
						@{user.login}
					</a>
				</div>
			</header>

			<div className="mt-8 flex flex-wrap gap-10">
				<Stat label="Public commits" value={total.toLocaleString()} />
				{hasPrivate && (
					<Stat
						label="Private contributions"
						value={totalRestricted.toLocaleString()}
					/>
				)}
				<Stat
					label="Busiest month"
					value={busiest ? monthYear(busiest.date) : "—"}
					hint={
						busiest
							? `${(busiest.commits + busiest.restricted).toLocaleString()} ${hasPrivate ? "contributions" : "commits"}`
							: undefined
					}
				/>
				<Stat label="Since" value={since} />
			</div>

			{hasPrivate && (
				<div className="mt-8 flex justify-end">
					<ChartModeToggle mode={mode} onChange={setMode} />
				</div>
			)}
			<motion.div
				initial={{ opacity: 0, filter: "blur(8px)" }}
				animate={{ opacity: 1, filter: "blur(0px)" }}
				transition={{ duration: 0.5 }}
				className="mt-3 rounded-xl border border-border p-4"
			>
				<CommitChart points={points} mode={hasPrivate ? mode : "public"} />
			</motion.div>

			<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
				<p className="text-xs text-muted-foreground">
					Cumulative commits attributed by GitHub since {since} — the same
					dataset as the contribution graph.
				</p>
				<AddUser currentLogins={otherLogins} label="Compare with…" />
			</div>

			<EmbedSnippet login={user.login} />
		</>
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
	const go = useGoToLogins();

	const series: ChartSeries[] = results.map((r, i) => ({
		login: r.login,
		color: SERIES_COLORS[i % SERIES_COLORS.length],
		// biome-ignore lint/style/noNonNullAssertion: ok results always have history
		points: r.history!.points,
	}));

	function removeLogin(login: string) {
		go(allLogins.filter((l) => l !== login));
	}

	return (
		<>
			<header className="mt-6 flex flex-wrap items-end justify-between gap-4">
				<div>
					<h1 className="text-2xl font-bold">Commit History</h1>
					<p className="text-sm text-muted-foreground">
						Comparing {series.length} developers
					</p>
				</div>
				<TimelineToggle mode={mode} onChange={setMode} />
			</header>

			<motion.div
				initial={{ opacity: 0, filter: "blur(8px)" }}
				animate={{ opacity: 1, filter: "blur(0px)" }}
				transition={{ duration: 0.5 }}
				className="mt-6 rounded-xl border border-border p-4"
			>
				<MultiCommitChart series={series} mode={mode} />
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
							rel="noreferrer"
							className="hover:underline"
						>
							{r.login}
						</a>
						<span className="tabular-nums text-muted-foreground">
							{/* biome-ignore lint/style/noNonNullAssertion: ok results have history */}
							{r.history!.total.toLocaleString()}
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
				<AddUser currentLogins={allLogins} label="Add user…" />
			</div>
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
							? "bg-foreground px-3 py-1.5 text-background"
							: "px-3 py-1.5 text-muted-foreground hover:bg-muted"
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
	both: "Both",
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
							? "bg-foreground px-3 py-1.5 text-background"
							: "px-3 py-1.5 text-muted-foreground hover:bg-muted"
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
		<form onSubmit={submit} className="inline-flex items-center gap-2">
			<input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder={label}
				aria-label={label}
				className="w-36 rounded-md border bg-transparent px-2 py-1 text-sm shadow-inner outline-none focus:shadow-[0_0_0_0.125em_var(--ring)]"
			/>
			<button type="submit" className="btn-secondary">
				Add
			</button>
		</form>
	);
}

function EmbedSnippet({ login }: { login: string }) {
	const [copied, setCopied] = useState(false);
	const markdown = `[![Commit History](https://commit-history.com/embed/${login})](https://commit-history.com/${login})`;

	async function copy() {
		try {
			await navigator.clipboard.writeText(markdown);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard unavailable */
		}
	}

	return (
		<section className="mt-10">
			<h2 className="text-sm font-semibold">Embed in your README</h2>
			<p className="mt-1 text-xs text-muted-foreground">
				Drops in a live chart that updates over time. Append{" "}
				<code className="rounded bg-muted px-1">?theme=dark</code> for dark
				mode.
			</p>
			<div className="mt-3 flex items-stretch gap-2">
				<code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md border bg-muted px-3 py-2 text-xs">
					{markdown}
				</code>
				<button type="button" onClick={copy} className="btn-secondary shrink-0">
					{copied ? "Copied!" : "Copy"}
				</button>
			</div>
		</section>
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
