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
	const pendingRows = data?.pendingRows ?? [];

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

			{pendingRows.length > 0 && (
				<div className="mt-6 rounded-lg bg-muted/45 px-4 py-4">
					<div className="flex items-baseline justify-between gap-3">
						<h3 className="text-sm font-semibold">Joining the leaderboard</h3>
						<span className="text-xs tabular-nums text-muted-foreground">
							{pendingRows.length.toLocaleString()} waiting
						</span>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						We already found these GitHub profiles. Their histories are being
						built in the background.
					</p>
					<ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
						{pendingRows.slice(0, 24).map((entry) => (
							<li
								key={entry.githubNodeId}
								className="flex min-w-0 items-center gap-2 rounded-md bg-background/70 px-2 py-1.5"
							>
								<img
									src={entry.avatarUrl ?? ""}
									alt=""
									className="h-7 w-7 shrink-0 rounded-full border border-border"
								/>
								<span className="min-w-0 flex-1 truncate text-xs font-medium">
									{entry.login}
								</span>
								<span
									className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
									aria-hidden="true"
								/>
							</li>
						))}
					</ul>
					{pendingRows.length > 24 && (
						<p className="mt-3 text-center text-xs text-muted-foreground">
							+{(pendingRows.length - 24).toLocaleString()} more profiles
							waiting
						</p>
					)}
				</div>
			)}
		</section>
	);
}

function progressCopy(
	data: Awaited<ReturnType<typeof getProfileNetwork>> | undefined,
): string {
	if (!data) {
		return "Looking up who this profile follows on GitHub. Most networks appear in a few seconds…";
	}
	if (data.hasError && data.rows.length <= 1) {
		return "This network could not be refreshed yet. It will retry automatically.";
	}
	if (data.status === "discovering") {
		return data.totalCount > 0
			? `Looking up the ${data.totalCount.toLocaleString()} profiles this person follows. Most networks appear in a few seconds…`
			: "Looking up who this profile follows on GitHub. Most networks appear in a few seconds…";
	}
	if (data.readyCount + data.unavailableCount < data.totalCount) {
		return `Following list found: history ready for ${data.readyCount.toLocaleString()} of ${data.totalCount.toLocaleString()} followed profiles. Keep this page open and new rankings will appear automatically.`;
	}
	if (data.unavailableCount > 0) {
		return `${data.readyCount.toLocaleString()} of ${data.totalCount.toLocaleString()} followed profiles are available; ${data.unavailableCount.toLocaleString()} could not be loaded.`;
	}
	return "Refreshing this GitHub network in the background…";
}
