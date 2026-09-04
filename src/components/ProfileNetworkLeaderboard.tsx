import { useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import type { ChartMode } from "#/components/CommitChart";
import { ExplainerLink } from "#/components/ExplainerLink";
import { LeaderboardRow } from "#/components/LeaderboardRow";
import { LEADERBOARD_HEADING } from "#/lib/leaderboard-display";
import { getProfileNetwork } from "#/lib/profile-network";

export function ProfileNetworkLeaderboard({
	login,
	ownerGithubNodeId,
	metric,
}: {
	login: string;
	ownerGithubNodeId: string;
	metric: ChartMode;
}) {
	const query = useQuery({
		queryKey: ["profile-network", ownerGithubNodeId, metric],
		queryFn: () => getProfileNetwork({ data: { ownerGithubNodeId, metric } }),
		refetchInterval: (current) => {
			const data = current.state.data;
			if (!data || data.status === "unavailable") return false;
			return data.status !== "ready" ||
				data.readyCount + data.unavailableCount < data.totalCount
				? 8_000
				: false;
		},
		refetchIntervalInBackground: false,
	});

	if (query.data?.status === "unavailable") return null;
	const data = query.data;
	const linkMetric = metric === "public" ? undefined : metric;
	const incomplete =
		!data ||
		data.status !== "ready" ||
		data.readyCount + data.unavailableCount < data.totalCount;
	const showStatus =
		query.isError || incomplete || Boolean(data?.unavailableCount);

	return (
		<section className="mt-16">
			<div className="sticky top-0 z-20 border-border border-b bg-background pt-3 pb-3">
				<h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xl font-bold tracking-tight">
					Network
					<span className="font-hand font-normal text-3xl text-primary leading-none">
						{LEADERBOARD_HEADING[metric]}
					</span>
					leaderboard
				</h2>
				<p className="mt-1.5 text-xs text-muted-foreground">
					{data
						? `${data.ownerLogin} and the GitHub profiles they follow.`
						: `${login} and the GitHub profiles they follow.`}{" "}
					<ExplainerLink metric={metric} />
				</p>
				{showStatus && (
					<p
						className="mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
						aria-live="polite"
					>
						{query.isError
							? "This network leaderboard is temporarily unavailable."
							: progressCopy(data)}
					</p>
				)}
			</div>

			{data && data.rows.length > 0 ? (
				<ol>
					<AnimatePresence initial={false} mode="popLayout">
						{data.rows.map((entry, index) => (
							<LeaderboardRow
								key={entry.githubNodeId}
								entry={entry}
								rank={index + 1}
								metric={metric}
								linkMetric={linkMetric}
								highlighted={entry.isOwner}
							/>
						))}
					</AnimatePresence>
				</ol>
			) : query.isError ? null : (
				<p className="py-8 text-center text-sm text-muted-foreground">
					Preparing this network leaderboard…
				</p>
			)}
		</section>
	);
}

function progressCopy(
	data: Awaited<ReturnType<typeof getProfileNetwork>> | undefined,
): string {
	if (!data) return "Finding the profiles in this GitHub network…";
	if (data.hasError && data.rows.length <= 1) {
		return "This network could not be refreshed yet. It will retry automatically.";
	}
	if (data.status === "discovering") {
		return data.totalCount > 0
			? `Finding the ${data.totalCount.toLocaleString()} profiles this person follows…`
			: "Finding the profiles this person follows…";
	}
	if (data.readyCount + data.unavailableCount < data.totalCount) {
		return `${data.readyCount.toLocaleString()} of ${data.totalCount.toLocaleString()} followed profiles ready. The rest are being added in the background; rankings update automatically.`;
	}
	if (data.unavailableCount > 0) {
		return `${data.readyCount.toLocaleString()} of ${data.totalCount.toLocaleString()} followed profiles are available; ${data.unavailableCount.toLocaleString()} could not be loaded.`;
	}
	return "Refreshing this GitHub network in the background…";
}
