import { GitHubError, isValidLogin } from "#/lib/github";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export interface FollowedProfile {
	githubNodeId: string;
	login: string;
	avatarUrl: string | null;
	htmlUrl: string | null;
}

interface GitHubFollowingRow {
	login?: unknown;
	node_id?: unknown;
	avatar_url?: unknown;
	html_url?: unknown;
}

/** Fetch one complete public `following` snapshot. Partial pagination is never returned. */
export async function fetchFollowing(
	login: string,
	token: string,
	signal?: AbortSignal,
): Promise<FollowedProfile[]> {
	if (!isValidLogin(login)) throw new GitHubError("Invalid GitHub login.", 400);
	const followed: FollowedProfile[] = [];
	const seen = new Set<string>();

	for (let page = 1; page <= MAX_PAGES; page += 1) {
		signal?.throwIfAborted();
		const url = new URL(
			`https://api.github.com/users/${encodeURIComponent(login)}/following`,
		);
		url.searchParams.set("per_page", String(PAGE_SIZE));
		url.searchParams.set("page", String(page));
		const response = await fetch(url, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"User-Agent": "commit-history",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal,
		});
		if (!response.ok) {
			const retryAfter = response.headers.get("retry-after");
			const suffix = retryAfter ? ` Retry after ${retryAfter}s.` : "";
			throw new GitHubError(
				response.status === 404
					? `User "${login}" not found.`
					: `GitHub following lookup failed (${response.status}).${suffix}`,
				response.status,
			);
		}

		const body = (await response.json()) as unknown;
		if (!Array.isArray(body)) {
			throw new GitHubError(
				"GitHub returned an invalid following response.",
				502,
			);
		}
		for (const value of body) {
			const row = value as GitHubFollowingRow;
			if (
				typeof row.login !== "string" ||
				!isValidLogin(row.login) ||
				typeof row.node_id !== "string" ||
				!row.node_id.trim()
			) {
				throw new GitHubError(
					"GitHub returned an invalid followed profile.",
					502,
				);
			}
			const nodeId = row.node_id.trim();
			if (seen.has(nodeId)) continue;
			seen.add(nodeId);
			followed.push({
				githubNodeId: nodeId,
				login: row.login,
				avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
				htmlUrl: typeof row.html_url === "string" ? row.html_url : null,
			});
		}

		if (!hasNextPage(response.headers.get("link"), body.length)) {
			return followed;
		}
	}

	throw new GitHubError(
		`GitHub following lookup exceeded ${MAX_PAGES * PAGE_SIZE} profiles.`,
		502,
	);
}

function hasNextPage(link: string | null, rowCount: number): boolean {
	if (link) return /<[^>]+>;\s*rel="next"/.test(link);
	return rowCount === PAGE_SIZE;
}
