import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import type { ChartMode } from "#/components/CommitChart";
import {
	LEADERBOARD_UNIT,
	type LeaderboardTotals,
	leaderboardValue,
} from "#/lib/leaderboard-display";
import type { LeaderMetric } from "#/lib/leaderboard-rank";
import { cn } from "#/lib/utils";

export interface LeaderboardRowEntry extends LeaderboardTotals {
	login: string;
	name: string | null;
	avatarUrl: string | null;
}

export function LeaderboardRow({
	entry,
	rank,
	metric,
	linkMetric,
	highlighted = false,
}: {
	entry: LeaderboardRowEntry;
	rank: number;
	metric: LeaderMetric;
	linkMetric?: ChartMode;
	highlighted?: boolean;
}) {
	return (
		<motion.li
			layout
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ type: "spring", stiffness: 600, damping: 40 }}
			className={cn("border-border border-b", highlighted && "bg-primary/5")}
		>
			<Link
				to="/$user"
				params={{ user: entry.login }}
				search={{ metric: linkMetric }}
				preload={false}
				className="group flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted"
			>
				<span className="flex w-6 items-center justify-center text-sm tabular-nums text-muted-foreground">
					{rank === 1 ? (
						<img src="/crown.svg" alt="1st place" className="h-4 w-auto" />
					) : (
						rank
					)}
				</span>
				<img
					src={entry.avatarUrl ?? ""}
					alt=""
					className="h-8 w-8 rounded-full border border-border"
				/>
				<span className="min-w-0 flex-1 truncate font-medium">
					{entry.login}
					{highlighted && (
						<span className="ml-2 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary uppercase tracking-wide">
							this profile
						</span>
					)}
					{entry.name && (
						<span className="ml-2 hidden font-normal text-muted-foreground opacity-0 transition-opacity duration-200 sm:inline desktop:group-hover:opacity-100 desktop:group-focus-within:opacity-100">
							{entry.name}
						</span>
					)}
				</span>
				<span className="text-right">
					<span className="block font-semibold tabular-nums">
						{leaderboardValue(entry, metric).toLocaleString()}
					</span>
					<span className="block text-xs text-muted-foreground tabular-nums">
						{LEADERBOARD_UNIT[metric]}
					</span>
				</span>
			</Link>
		</motion.li>
	);
}
