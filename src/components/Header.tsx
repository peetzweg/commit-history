import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getRepoStars } from "#/lib/commit-history";

// Dark top bar, a homage to star-history.com's header (#363636 / light text).
export function Header() {
	// Live GitHub star count, shown next to the source link. Cached for the session; absent until it
	// loads (and if the fetch fails, just omitted).
	const { data: stars } = useQuery({
		queryKey: ["repo-stars"],
		queryFn: () => getRepoStars(),
		staleTime: 1000 * 60 * 60,
	});
	return (
		<header className="flex h-14 w-full shrink-0 flex-row items-center justify-between bg-foreground pr-2 pl-1 text-[#f5f5f5] sm:px-4">
			<div className="flex h-full min-w-0 flex-row items-center">
				<Link to="/" className="header-link" aria-label="Commit History — home">
					<img src="/crown.svg" alt="" className="h-6 w-auto shrink-0" />
				</Link>
			</div>
			<div className="flex h-full flex-row items-center gap-1 sm:gap-4">
				<a
					href="https://www.star-history.com/"
					target="_blank"
					rel="noopener"
					className="header-link hidden text-sm sm:flex"
					title="Inspired by star-history.com"
				>
					a homage to star-history
				</a>
				<a
					href="https://github.com/peetzweg/commit-history"
					target="_blank"
					rel="noopener"
					className="header-link gap-2"
					title="Star commit-history on GitHub"
					aria-label="View source on GitHub"
				>
					<svg
						viewBox="0 0 16 16"
						width="20"
						height="20"
						fill="currentColor"
						aria-hidden="true"
					>
						<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
					</svg>
					{typeof stars === "number" && (
						<span className="font-hand text-lg leading-none">
							{stars.toLocaleString()}
						</span>
					)}
					<span className="sr-only">GitHub stars</span>
				</a>
			</div>
		</header>
	);
}
