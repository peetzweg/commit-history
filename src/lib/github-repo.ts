/**
 * GitHub repository data layer for the repository leaderboard (#212). Research and the cost
 * measurements behind these shapes: docs/research/repository-leaderboard-github-api.md.
 *
 * Four sources, each cheap in a different way:
 *
 *   - `fetchRepoSnapshot` — ONE GraphQL query (1 point) for every current stock: stars, forks,
 *     watchers, issue/PR state counts, releases, the default branch (read, never assumed) with its
 *     tip SHA, and `history.totalCount` for exact commits reachable from that tip.
 *   - `fetchContributorStats` — REST `/stats/contributors`. Separate REST quota, but GitHub
 *     computes it asynchronously: the first request often answers 202 and must be retried.
 *   - `fetchRepoMonthlyFlows` — aliased GraphQL `search` counts + `history(since, until)` windows.
 *     A year of monthly opened/closed/merged counts is one 1-point query.
 *   - `fetchStargazerDates` — paginated `stargazers.starredAt`, 100 stars per point. The only
 *     source whose cost grows with the repo's size, so the caller caps it.
 */

import {
	GitHubError,
	graphql,
	isValidLogin,
	type MonthWindow,
} from "#/lib/github";

const GITHUB_REST = "https://api.github.com";

// GitHub repository names: ASCII letters, digits, '.', '-', '_'; max 100. Like LOGIN_RE this is an
// injection guard for interpolating into GraphQL/search strings, not GitHub's full naming policy.
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface RepoRef {
	owner: string;
	name: string;
}

/** Parse `owner/name` (the leaderboard's repo id format). Null when either half is unsafe. */
export function parseRepoRef(raw: string): RepoRef | null {
	const [owner, name, ...rest] = raw.trim().split("/");
	if (rest.length || !owner || !name) return null;
	if (!isValidLogin(owner) || !REPO_NAME_RE.test(name)) return null;
	if (name === "." || name === "..") return null;
	return { owner, name };
}

/** Canonical storage id: lowercased `owner/name` (GitHub resolves both case-insensitively). */
export function repoId(ref: RepoRef): string {
	return `${ref.owner}/${ref.name}`.toLowerCase();
}

export interface RepoSnapshot {
	nodeId: string;
	owner: string;
	name: string;
	description: string | null;
	ownerAvatarUrl: string | null;
	primaryLanguage: string | null;
	license: string | null;
	createdAt: string;
	pushedAt: string | null;
	isArchived: boolean;
	isFork: boolean;
	/** Null for an empty repository (no commits, so no default branch ref yet). */
	defaultBranch: string | null;
	defaultBranchTipSha: string | null;
	commits: number;
	commitsLastYear: number;
	stars: number;
	forks: number;
	watchers: number;
	openIssues: number;
	closedIssues: number;
	openPullRequests: number;
	mergedPullRequests: number;
	closedPullRequests: number;
	releases: number;
}

interface RawSnapshot {
	repository: {
		id: string;
		name: string;
		owner: { login: string; avatarUrl: string };
		description: string | null;
		primaryLanguage: { name: string } | null;
		licenseInfo: { spdxId: string | null } | null;
		createdAt: string;
		pushedAt: string | null;
		isArchived: boolean;
		isFork: boolean;
		stargazerCount: number;
		forkCount: number;
		watchers: { totalCount: number };
		openIssues: { totalCount: number };
		closedIssues: { totalCount: number };
		openPRs: { totalCount: number };
		mergedPRs: { totalCount: number };
		closedPRs: { totalCount: number };
		releases: { totalCount: number };
		defaultBranchRef: {
			name: string;
			target: {
				oid?: string;
				history?: { totalCount: number };
				lastYear?: { totalCount: number };
			} | null;
		} | null;
	} | null;
}

/** The current state of one repository. 404 (GitHubError) when GitHub can't resolve it. */
export async function fetchRepoSnapshot(
	ref: RepoRef,
	token: string,
	now: Date,
): Promise<RepoSnapshot> {
	const since = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
	const data = await graphql<RawSnapshot>(
		token,
		`query { repository(owner: "${ref.owner}", name: "${ref.name}") {
			id name description createdAt pushedAt isArchived isFork stargazerCount forkCount
			owner { login avatarUrl }
			primaryLanguage { name }
			licenseInfo { spdxId }
			watchers { totalCount }
			openIssues: issues(states: OPEN) { totalCount }
			closedIssues: issues(states: CLOSED) { totalCount }
			openPRs: pullRequests(states: OPEN) { totalCount }
			mergedPRs: pullRequests(states: MERGED) { totalCount }
			closedPRs: pullRequests(states: CLOSED) { totalCount }
			releases { totalCount }
			defaultBranchRef { name target { ... on Commit {
				oid
				history(first: 0) { totalCount }
				lastYear: history(first: 0, since: "${since.toISOString()}") { totalCount }
			} } }
		} }`,
	);
	const r = data.repository;
	if (!r) {
		throw new GitHubError(
			`Repository "${ref.owner}/${ref.name}" not found.`,
			404,
		);
	}
	const target = r.defaultBranchRef?.target ?? null;
	return {
		nodeId: r.id,
		owner: r.owner.login,
		name: r.name,
		description: r.description,
		ownerAvatarUrl: r.owner.avatarUrl ?? null,
		primaryLanguage: r.primaryLanguage?.name ?? null,
		// GitHub reports unrecognised licenses as spdxId "NOASSERTION" — no more useful than null.
		license:
			r.licenseInfo?.spdxId && r.licenseInfo.spdxId !== "NOASSERTION"
				? r.licenseInfo.spdxId
				: null,
		createdAt: r.createdAt,
		pushedAt: r.pushedAt,
		isArchived: r.isArchived,
		isFork: r.isFork,
		defaultBranch: r.defaultBranchRef?.name ?? null,
		defaultBranchTipSha: target?.oid ?? null,
		commits: target?.history?.totalCount ?? 0,
		commitsLastYear: target?.lastYear?.totalCount ?? 0,
		stars: r.stargazerCount,
		forks: r.forkCount,
		watchers: r.watchers.totalCount,
		openIssues: r.openIssues.totalCount,
		closedIssues: r.closedIssues.totalCount,
		openPullRequests: r.openPRs.totalCount,
		mergedPullRequests: r.mergedPRs.totalCount,
		closedPullRequests: r.closedPRs.totalCount,
		releases: r.releases.totalCount,
	};
}

/** One row of REST `/stats/contributors`. `author` is null for commits with no linked account. */
export interface ContributorStatsRow {
	author: { login: string } | null;
	total: number;
	weeks: Array<{ w: number; c: number }>;
}

export type ContributorStatsResult =
	| { status: "ready"; rows: ContributorStatsRow[] }
	/** GitHub is still computing (202) — retry later; never present old numbers as fresh. */
	| { status: "pending" }
	/** Empty repo (204) or GitHub declines to compute statistics for it. */
	| { status: "unavailable" };

/**
 * REST `/stats/contributors`, one request. GitHub caches the result per default-branch SHA and
 * answers 202 while (re)computing it, so callers retry with backoff — see repo-refresh.ts.
 *
 * NOT a contributor count: for most repos GitHub returns only the top 100 contributors (measured
 * 2026-09: substrate, ink and polkadot-js/api all return exactly 100 rows against 142–483 real
 * contributors). Use it for weekly activity and treat everything derived from a 100-row answer as
 * a lower bound. The count comes from `fetchContributorCounts`.
 */
export async function fetchContributorStats(
	ref: RepoRef,
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ContributorStatsResult> {
	const res = await fetchImpl(
		`${GITHUB_REST}/repos/${ref.owner}/${ref.name}/stats/contributors`,
		{
			headers: restHeaders(token),
		},
	);
	if (res.status === 202) return { status: "pending" };
	if (res.status === 204 || res.status === 422)
		return { status: "unavailable" };
	if (res.status === 404) {
		throw new GitHubError(
			`Repository "${ref.owner}/${ref.name}" not found.`,
			404,
		);
	}
	if (!res.ok) {
		throw new GitHubError(`GitHub API error (${res.status}).`, res.status);
	}
	const body = (await res.json()) as unknown;
	// An empty object (rather than an array) also means "not computed yet".
	if (!Array.isArray(body)) return { status: "pending" };
	return { status: "ready", rows: body as ContributorStatsRow[] };
}

const restHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github+json",
	"User-Agent": "commit-history",
});

/** Item count of a paginated REST list fetched with per_page=1: the `last` page number. */
async function countList(
	url: string,
	token: string,
	fetchImpl: typeof fetch,
): Promise<number | null> {
	const res = await fetchImpl(url, { headers: restHeaders(token) });
	if (res.status === 204) return 0;
	// 403 here is GitHub's "contributor list is too large to list via the API" (torvalds/linux);
	// rate limits come back as 403 too, but carry x-ratelimit-remaining: 0.
	if (res.status === 403 && res.headers.get("x-ratelimit-remaining") !== "0") {
		return null;
	}
	if (res.status === 404) throw new GitHubError(`Not found: ${url}`, 404);
	if (!res.ok)
		throw new GitHubError(`GitHub API error (${res.status}).`, res.status);
	const last = res.headers
		.get("link")
		?.match(/[?&]page=(\d+)>;\s*rel="last"/)?.[1];
	if (last) return Number(last);
	const body = (await res.json()) as unknown[];
	return Array.isArray(body) ? body.length : 0;
}

export interface ContributorCounts {
	/** Distinct contributors, anonymous (unlinked author emails) included. */
	total: number;
	/** Contributors linked to a GitHub account. */
	linked: number;
}

/**
 * Contributor totals from REST `/contributors`, two requests, no pagination: with per_page=1 the
 * `last` link's page number *is* the count. GitHub deduplicates by author email and links only
 * the first 500 emails to accounts, so `linked` undercounts on very large repos. Null when GitHub
 * refuses to list the contributors at all.
 */
export async function fetchContributorCounts(
	ref: RepoRef,
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ContributorCounts | null> {
	const base = `${GITHUB_REST}/repos/${ref.owner}/${ref.name}/contributors?per_page=1`;
	const total = await countList(`${base}&anon=true`, token, fetchImpl);
	if (total == null) return null;
	const linked = await countList(base, token, fetchImpl);
	return { total, linked: linked ?? total };
}

export interface MonthlyFlow {
	/** First-of-month label, YYYY-MM-DD. */
	month: string;
	commits: number;
	issuesOpened: number;
	issuesClosed: number;
	pullRequestsOpened: number;
	pullRequestsMerged: number;
}

// Months per query: 12 × (4 searches + 1 history window) = 60 aliases, measured at 1 point and
// ~3.5s against paritytech/polkadot-sdk. Larger batches only add gateway-timeout risk.
export const MONTHLY_FLOW_BATCH = 12;

/**
 * Monthly flow counts for `windows` (at most MONTHLY_FLOW_BATCH), in one GraphQL query. Search
 * counts are exact for counting purposes — `issueCount` is not subject to the 1,000-result cap
 * that limits paginating search results.
 */
export async function fetchRepoMonthlyFlows(
	ref: RepoRef,
	windows: MonthWindow[],
	token: string,
): Promise<MonthlyFlow[]> {
	if (windows.length > MONTHLY_FLOW_BATCH) {
		throw new Error(`At most ${MONTHLY_FLOW_BATCH} months per query.`);
	}
	if (!windows.length) return [];
	const repo = `repo:${ref.owner}/${ref.name}`;
	const count = (alias: string, q: string) =>
		`${alias}: search(type: ISSUE, query: "${repo} ${q}", first: 0) { issueCount }`;
	const searches = windows
		.map((w, i) => {
			const range = `${w.from}..${w.to}`;
			return [
				count(`io${i}`, `is:issue created:${range}`),
				count(`ic${i}`, `is:issue closed:${range}`),
				count(`po${i}`, `is:pr created:${range}`),
				count(`pm${i}`, `is:pr merged:${range}`),
			].join("\n");
		})
		.join("\n");
	const history = windows
		.map(
			(w, i) =>
				`c${i}: history(first: 0, since: "${w.from}", until: "${w.to}") { totalCount }`,
		)
		.join("\n");
	type Count = { issueCount: number };
	const data = await graphql<
		Record<string, Count> & {
			repository: {
				defaultBranchRef: {
					target: Record<string, { totalCount: number }> | null;
				} | null;
			} | null;
		}
	>(
		token,
		`query {
			${searches}
			repository(owner: "${ref.owner}", name: "${ref.name}") {
				defaultBranchRef { target { ... on Commit { ${history} } } }
			}
		}`,
	);
	if (!data.repository) {
		throw new GitHubError(
			`Repository "${ref.owner}/${ref.name}" not found.`,
			404,
		);
	}
	const target = data.repository.defaultBranchRef?.target ?? null;
	return windows.map((w, i) => ({
		month: w.label,
		commits: target?.[`c${i}`]?.totalCount ?? 0,
		issuesOpened: data[`io${i}`]?.issueCount ?? 0,
		issuesClosed: data[`ic${i}`]?.issueCount ?? 0,
		pullRequestsOpened: data[`po${i}`]?.issueCount ?? 0,
		pullRequestsMerged: data[`pm${i}`]?.issueCount ?? 0,
	}));
}

/**
 * Every `starredAt` timestamp, oldest first. Costs ceil(stars / 100) points; `onPage` lets the
 * caller account for each one against its budget and abort by returning false (→ null result).
 * Unstarred-then-deleted accounts are gone from this list, so the sum can trail `stargazerCount`.
 */
export async function fetchStargazerDates(
	ref: RepoRef,
	token: string,
	onPage: () => Promise<boolean>,
): Promise<string[] | null> {
	const dates: string[] = [];
	let after: string | null = null;
	for (;;) {
		if (!(await onPage())) return null;
		const data: {
			repository: {
				stargazers: {
					pageInfo: { hasNextPage: boolean; endCursor: string | null };
					edges: Array<{ starredAt: string }>;
				};
			} | null;
		} = await graphql(
			token,
			`query { repository(owner: "${ref.owner}", name: "${ref.name}") {
				stargazers(first: 100, orderBy: { field: STARRED_AT, direction: ASC }${
					// Cursors are opaque base64 from GitHub itself, never user input.
					after ? `, after: "${after}"` : ""
				}) {
					pageInfo { hasNextPage endCursor }
					edges { starredAt }
				}
			} }`,
		);
		if (!data.repository) {
			throw new GitHubError(
				`Repository "${ref.owner}/${ref.name}" not found.`,
				404,
			);
		}
		const page = data.repository.stargazers;
		for (const e of page.edges) dates.push(e.starredAt);
		if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return dates;
		after = page.pageInfo.endCursor;
	}
}
