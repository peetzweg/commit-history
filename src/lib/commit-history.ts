import { createServerFn } from "@tanstack/react-start";
import { getCommitHistory as getCachedCommitHistory } from "#/lib/cache";
import { type CommitHistory, GitHubError } from "#/lib/github";

/**
 * Server function: resolves a username's lifetime commit history.
 *
 * The GitHub token lives only on the server (env `GITHUB_TOKEN`), so it is never shipped to the
 * client. For the MVP a single PAT serves every public-username request; see README for the
 * scaling path (per-user OAuth / GitHub App).
 *
 * NOTE: do NOT rename this file to `*.server.ts`. The `.server` suffix triggers Vite/TanStack
 * import-protection, which replaces the whole module with a mock on the client — the loader then
 * receives the mock instead of the client RPC stub, and the chart crashes with
 * "points.map is not iterable". `createServerFn` already strips the handler from the client bundle
 * on its own, so the server-only deps (cache, github, process.env) never reach the browser.
 */
function serverToken(): string {
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		throw new GitHubError(
			"Server is missing GITHUB_TOKEN. Add it to .env (see .env.example).",
			500,
		);
	}
	return token;
}

export const getCommitHistory = createServerFn({ method: "GET" })
	.validator((login: string) => login)
	.handler(async ({ data: login }): Promise<CommitHistory> => {
		return getCachedCommitHistory(login, serverToken());
	});

const MAX_USERS = 8;

/** Parse a comma-separated `$user` param into a clean, deduped, capped login list. */
export function parseLogins(raw: string): string[] {
	const seen = new Set<string>();
	const logins: string[] = [];
	for (const part of decodeURIComponent(raw).split(",")) {
		const login = part.trim();
		const key = login.toLowerCase();
		if (login && !seen.has(key)) {
			seen.add(key);
			logins.push(login);
		}
	}
	return logins.slice(0, MAX_USERS);
}

export interface UserResult {
	login: string;
	history: CommitHistory | null;
	error: string | null;
}

/**
 * Resolve several users' histories in one round-trip, tolerating partial failure so one bad
 * username doesn't sink the whole comparison.
 */
export const getCommitHistories = createServerFn({ method: "GET" })
	.validator((logins: string[]) => logins)
	.handler(async ({ data: logins }): Promise<UserResult[]> => {
		const token = serverToken();
		return Promise.all(
			logins.map(async (login): Promise<UserResult> => {
				try {
					const history = await getCachedCommitHistory(login, token);
					return { login, history, error: null };
				} catch (e) {
					return {
						login,
						history: null,
						error: e instanceof Error ? e.message : "Failed to load",
					};
				}
			}),
		);
	});
