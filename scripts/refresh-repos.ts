/**
 * Refresh the repository leaderboard (#212): current snapshot for every due repo, contributor
 * statistics (retrying GitHub's 202 "still computing"), and — unless --no-backfill — monthly flow
 * history back to each repo's first month plus star history for repos under --max-stars.
 *
 * Prototype stage: runs locally against the development database only. Not yet a Coolify
 * scheduled task, though it follows the same job recipe (lock, budget floor, runtime cap,
 * resumable off freshness markers) so it can become one without changes:
 *
 *   node --env-file=.env.new --import tsx scripts/refresh-repos.ts paritytech/polkadot-sdk
 *   node --env-file=.env.new --import tsx scripts/refresh-repos.ts          # every due repo
 *   node --env-file=.env.new --import tsx scripts/refresh-repos.ts --dry-run
 *
 * Naming repos (`owner/name`) adds them to tracking and refreshes exactly those, regardless of
 * freshness. With no names, every tracked repo whose snapshot is older than --stale-hours (or
 * whose contributor statistics are still pending) is refreshed.
 *
 * Beware a shell-exported GITHUB_TOKEN shadowing the env file: prefix with `env -u GITHUB_TOKEN`.
 */
import { db } from "#/lib/db";
import { fetchRateLimitBudget } from "#/lib/github";
import {
	fetchContributorCounts,
	fetchContributorStats,
	fetchRepoMonthlyFlows,
	fetchRepoSnapshot,
	fetchStargazerDates,
	parseRepoRef,
	type RepoRef,
	repoId,
} from "#/lib/github-repo";
import { createBudgetGuard, defaultSleep } from "#/lib/job-runner";
import { runRepoRefresh } from "#/lib/repo-refresh";
import { createRepoRefreshStore } from "#/lib/repo-refresh-store";

const VALID_FLAGS = new Set([
	"dry-run",
	"h",
	"help",
	"max-repos",
	"max-requests",
	"max-runtime-minutes",
	"max-stars",
	"no-backfill",
	"remaining-floor",
	"stale-hours",
]);

const { flags, names } = parseArgv(process.argv.slice(2));
const env = process.env;

if (flags.has("help") || flags.has("h")) {
	console.log(usage());
	process.exit(0);
}

const GITHUB_TOKEN = env.GITHUB_TOKEN;
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required.");
if (!db) throw new Error("Database client failed to initialise.");

const refs: RepoRef[] = names.map((raw) => {
	const ref = parseRepoRef(raw);
	if (!ref) throw new Error(`"${raw}" is not an owner/name repository.`);
	return ref;
});

const startedAt = Date.now();
const maxRuntimeMs =
	numberValue("max-runtime-minutes", env.REPO_REFRESH_MAX_RUNTIME_MINUTES, 60) *
	60_000;
const runtimeLeftMs = () => maxRuntimeMs - (Date.now() - startedAt);

const result = await runRepoRefresh({
	store: createRepoRefreshStore(db),
	fetchers: {
		snapshot: (ref, now) => fetchRepoSnapshot(ref, GITHUB_TOKEN, now),
		contributorStats: (ref) => fetchContributorStats(ref, GITHUB_TOKEN),
		contributorCounts: (ref) => fetchContributorCounts(ref, GITHUB_TOKEN),
		monthlyFlows: (ref, windows) =>
			fetchRepoMonthlyFlows(ref, windows, GITHUB_TOKEN),
		stargazerDates: (ref, onPage) =>
			fetchStargazerDates(ref, GITHUB_TOKEN, onPage),
	},
	budget: createBudgetGuard({
		label: "repo-refresh",
		remainingFloor: numberValue(
			"remaining-floor",
			env.REPO_REFRESH_REMAINING_FLOOR,
			500,
		),
		pollEvery: 25,
		fetchRateLimit: () => fetchRateLimitBudget(GITHUB_TOKEN),
		sleep: defaultSleep,
		nowMs: Date.now,
		runtimeLeftMs,
		logger: console,
	}),
	logger: console,
	sleep: defaultSleep,
	now: () => new Date(),
	runtimeLeftMs,
	track: refs,
	only: refs.map(repoId),
	maxRepos: numberValue("max-repos", env.REPO_REFRESH_MAX_REPOS, 200),
	maxRequests: numberValue("max-requests", env.REPO_REFRESH_MAX_REQUESTS, 1000),
	staleAfterMs:
		numberValue("stale-hours", env.REPO_REFRESH_STALE_HOURS, 20) * 3_600_000,
	// GitHub usually finishes computing statistics within a few seconds to a minute.
	statsRetryDelaysMs: [3_000, 10_000, 30_000],
	backfill: !flags.has("no-backfill"),
	maxStars: numberValue("max-stars", env.REPO_REFRESH_MAX_STARS, 20_000),
	dryRun: flags.has("dry-run") || env.REPO_REFRESH_DRY_RUN === "true",
});

console.log(
	`repo-refresh done status=${result.status} repos=${result.repos} refreshed=${result.refreshed} stats_pending=${result.statsPending} unreachable=${result.unreachable} failed=${result.failed} months=${result.months} star_pages=${result.starPages} requests=${result.requests}`,
);

await shutdown(
	result.status !== "locked" && result.failed > 0 && result.refreshed === 0 ? 1 : 0,
);

/** Same best-effort pool shutdown as refresh-orgs: a teardown throw must not fail a finished run. */
async function shutdown(code: number): Promise<never> {
	process.on("uncaughtException", (err) => {
		console.warn(
			`repo-refresh status=shutdown_error error=${JSON.stringify(String(err))}`,
		);
		process.exit(code);
	});
	await db?.$client.end({ timeout: 5 }).catch(() => {});
	process.exit(code);
}

function parseArgv(argv: string[]) {
	const flags = new Map<string, string | true>();
	const names: string[] = [];
	for (const arg of argv) {
		if (!arg.startsWith("--")) {
			names.push(arg);
			continue;
		}
		const [name, ...rest] = arg.slice(2).split("=");
		if (!VALID_FLAGS.has(name)) throw new Error(`Unknown flag "--${name}".`);
		flags.set(name, rest.length === 0 ? true : rest.join("="));
	}
	return { flags, names };
}

function numberValue(
	name: string,
	envValue: string | undefined,
	fallback: number,
): number {
	const flagValue = flags.get(name);
	if (flagValue === true) throw new Error(`--${name} requires a value.`);
	const raw = typeof flagValue === "string" ? flagValue : envValue;
	if (raw == null || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`--${name} must be a non-negative integer.`);
	}
	return value;
}

function usage(): string {
	return [
		"Usage:",
		"  node --env-file=.env.new --import tsx scripts/refresh-repos.ts [flags] [owner/name…]",
		"",
		"Flags override env vars:",
		"  --dry-run                  env REPO_REFRESH_DRY_RUN",
		"  --no-backfill              skip monthly + star history",
		"  --max-repos=N              env REPO_REFRESH_MAX_REPOS, default 200",
		"  --max-requests=N           env REPO_REFRESH_MAX_REQUESTS, default 1000 GraphQL points",
		"  --max-stars=N              env REPO_REFRESH_MAX_STARS, default 20000 (0 = no star back-fill)",
		"  --stale-hours=N            env REPO_REFRESH_STALE_HOURS, default 20",
		"  --remaining-floor=N        env REPO_REFRESH_REMAINING_FLOOR, default 500",
		"  --max-runtime-minutes=N    env REPO_REFRESH_MAX_RUNTIME_MINUTES, default 60",
	].join("\n");
}
