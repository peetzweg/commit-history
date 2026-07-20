import { Link } from "@tanstack/react-router";

/**
 * A static, presentational leaderboard used at the top of ranking posts. Deliberately mirrors the
 * live board on the homepage (src/routes/index.tsx): crown for first place, avatar, rank, login
 * with the display name beside it, and the metric value with its unit underneath. Unlike the live
 * board it takes plain rows (no data fetching, no animation), so a post can render its snapshot as
 * MDX. Avatars come from github.com/<login>.png — no API/token — matching <Person>.
 */
interface RankRow {
	login: string;
	name?: string;
	/** Pre-formatted value shown big (e.g. "54.0k"); the post controls rounding. */
	value: string;
	/** Optional note shown where the name goes (e.g. "bot") when there is no person. */
	note?: string;
}

export function RankBoard({ unit, rows }: { unit: string; rows: RankRow[] }) {
	return (
		<ol className="not-prose my-6 overflow-hidden rounded-xl border border-border">
			{rows.map((u, i) => (
				<li key={u.login} className="border-border border-b last:border-b-0">
					<Link
						to="/$user"
						params={{ user: u.login }}
						className="group flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted"
					>
						<span className="flex w-6 shrink-0 items-center justify-center text-sm tabular-nums text-muted-foreground">
							{i === 0 ? (
								<img src="/crown.svg" alt="1st place" className="h-4 w-auto" />
							) : (
								i + 1
							)}
						</span>
						<img
							src={`https://github.com/${u.login}.png?size=64`}
							alt=""
							width={32}
							height={32}
							loading="lazy"
							className="h-8 w-8 shrink-0 rounded-full border border-border bg-muted"
						/>
						<span className="flex-1 truncate">
							<span className="font-medium">{u.login}</span>
							{u.name && (
								<span className="ml-2 font-normal text-muted-foreground">
									{u.name}
								</span>
							)}
							{u.note && (
								<span className="ml-2 font-normal text-muted-foreground">
									({u.note})
								</span>
							)}
						</span>
						<span className="shrink-0 text-right">
							<span className="block font-semibold tabular-nums">
								{u.value}
							</span>
							<span className="block text-xs text-muted-foreground">
								{unit}
							</span>
						</span>
					</Link>
				</li>
			))}
		</ol>
	);
}
