import { Link } from "@tanstack/react-router";

/**
 * Compact profile header for a developer inside a post — avatar, handle linking to their
 * commit-history profile, a follower/commit stat line, and a link out to GitHub. Rendered above
 * each person's chart in ranking articles (used from MDX via the shared component map).
 *
 * The avatar comes straight from github.com/<login>.png (a stable public redirect to the CDN
 * avatar — no API call, no token). `not-prose` keeps the typography wrapper from restyling it.
 */
export function Person({
	login,
	followers,
	commits,
}: {
	login: string;
	followers: string;
	commits: string;
}) {
	return (
		<div className="not-prose my-5 flex items-center gap-3">
			<img
				src={`https://github.com/${login}.png?size=88`}
				alt=""
				width={44}
				height={44}
				loading="lazy"
				className="h-11 w-11 shrink-0 rounded-full border border-border bg-muted"
			/>
			<div className="min-w-0 text-sm leading-tight">
				<Link
					to="/$user"
					params={{ user: login }}
					className="font-medium hover:underline"
				>
					@{login}
				</Link>
				<div className="text-muted-foreground">
					{followers} followers · {commits} commits ·{" "}
					<a
						href={`https://github.com/${login}`}
						target="_blank"
						rel="noopener"
						className="hover:text-foreground hover:underline"
					>
						GitHub ↗
					</a>
				</div>
			</div>
		</div>
	);
}
