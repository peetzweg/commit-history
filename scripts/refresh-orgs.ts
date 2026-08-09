/**
 * Keep every organization's numbers current. One job, one schedule, no manual upkeep.
 *
 * Bundled by `pnpm build` into `.output/worker/refresh-orgs.mjs`, which is what the production
 * image runs as a Coolify scheduled task (daily, 06:00 UTC — deliberately clear of the monthly
 * user refresh, which runs on the 1st at 03:00 and takes a couple of hours):
 *
 *   node .output/worker/refresh-orgs.mjs
 *
 * Locally, `pnpm refresh:orgs` runs this source through tsx.
 *
 * The engine (src/lib/org-refresh.ts) works in units of ONE (org, member) pair, so it is designed
 * to never finish and never block: it spends at most --max-requests per run, keeps a floor of the
 * GitHub budget free for live traffic, stops on a wall-clock cap, and resumes off
 * `org_members.last_fetched`. Every member row falls out of currency on the 1st of the month, so
 * the queue refills itself and every org converges on "current as of the last completed month"
 * without anyone naming an org. A 4,000-member org is 4,000 queue entries chipped away over
 * several nights, not a run that has to survive seven hours.
 *
 * It also self-heals: the monthly membership re-enumeration is what discovers members who joined,
 * or who made an existing membership public, after the org was first built (#150).
 *
 * Execute-by-default. `--dry-run` reports the head of the queue without spending requests or
 * writing rows.
 *
 *   node .output/worker/refresh-orgs.mjs          # the nightly run — no arguments needed
 *   pnpm refresh:orgs --dry-run                   # preview
 *   pnpm refresh:orgs NixOS                       # debug: refresh one org's members now
 *
 * Naming orgs is a debug escape hatch, not part of normal operation — it refreshes every member of
 * those orgs regardless of freshness and skips the enumeration phase.
 *
 * Member enumeration needs the read:org token from .env, so beware a shell-exported GITHUB_TOKEN
 * shadowing it: prefix local runs with `env -u GITHUB_TOKEN` if your shell sets one.
 */
import { db } from "#/lib/db";
import {
	fetchOrgMemberContributions,
	fetchOrgMembers,
	fetchOrgProfile,
	fetchRateLimitBudget,
	yearlyWindows,
} from "#/lib/github";
import { runOrgRefresh } from "#/lib/org-refresh";
import { createOrgRefreshStore } from "#/lib/org-refresh-store";

const VALID_FLAGS = new Set([
	"dry-run",
	"h",
	"help",
	"max-enumerations",
	"max-requests",
	"max-runtime-minutes",
	"member-pages",
	"poll-every",
	"rate-per-hour",
	"remaining-floor",
]);

const { flags, logins } = parseArgv(process.argv.slice(2));
const env = process.env;

if (booleanFlag(flags, "help") || booleanFlag(flags, "h")) {
	console.log(usage());
	process.exit(0);
}

const DATABASE_URL = env.DATABASE_URL;
const GITHUB_TOKEN = env.GITHUB_TOKEN;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required.");
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required.");
if (!db) throw new Error("Database client failed to initialise.");

const maxRuntimeMinutes = numberValue(
	flags,
	"max-runtime-minutes",
	env.ORG_REFRESH_MAX_RUNTIME_MINUTES,
	240,
);

const result = await runOrgRefresh({
	store: createOrgRefreshStore(db),
	token: GITHUB_TOKEN,
	now: new Date(),
	logins: logins.length > 0 ? logins : undefined,
	dryRun: booleanFlag(flags, "dry-run") || isTrue(env.ORG_REFRESH_DRY_RUN),
	// ~3,600 requests a night covers a full sweep of every org member roughly monthly, which is
	// exactly the freshness target. Raise it for a catch-up, not as a habit.
	maxRequests: numberValue(
		flags,
		"max-requests",
		env.ORG_REFRESH_MAX_REQUESTS,
		3600,
	),
	maxEnumerations: numberValue(
		flags,
		"max-enumerations",
		env.ORG_REFRESH_MAX_ENUMERATIONS,
		100,
	),
	ratePerHour: numberValue(
		flags,
		"rate-per-hour",
		env.ORG_REFRESH_RATE_PER_HOUR,
		1200,
	),
	remainingFloor: numberValue(
		flags,
		"remaining-floor",
		env.ORG_REFRESH_REMAINING_FLOOR,
		500,
	),
	pollEvery: numberValue(flags, "poll-every", env.ORG_REFRESH_POLL_EVERY, 25),
	// Must clear GitHub's largest orgs: microsoft alone is ~4,400 public members, and a cap below
	// that silently stores a prefix of the membership (#150). 60 pages = 6,000 members.
	memberPages: numberValue(
		flags,
		"member-pages",
		env.ORG_REFRESH_MEMBER_PAGES,
		60,
	),
	maxRuntimeMs: maxRuntimeMinutes * 60_000,
	// The token is shared with live site traffic, so the run polls its own GraphQL budget and
	// refuses to spend below the floor. `rateLimit` queries cost 0 points.
	fetchRateLimit: () => fetchRateLimitBudget(GITHUB_TOKEN),
	fetchOrgProfile,
	fetchOrgMembers,
	fetchOrgMemberContributions,
	yearlyWindows,
	logger: console,
});

// Stopping on a cap is normal: the queue is the retry mechanism and tomorrow's run continues.
// A systemic fault is not, and a scheduled task that exits 0 while achieving nothing is invisible
// in Coolify — so that case exits non-zero and shows up as a failed execution.
const achievedNothing =
	!result.dryRun &&
	result.membersFetched === 0 &&
	result.orgsEnumerated === 0 &&
	(result.orgsFailed > 0 || result.membersFailed > 0);
const systemicFailure =
	result.stopReason === "consecutive_failures" || achievedNothing;

await shutdown(systemicFailure ? 1 : 0);

/**
 * Close the pool so Postgres isn't left holding idle backends until TCP keepalive reaps them —
 * best-effort only. postgres.js can throw *asynchronously* while tearing sockets down (seen when
 * the link to the database blipped mid-run), and an uncaught throw at this point would turn a run
 * that already did its work and logged its summary into a failed Coolify execution. Shutdown is
 * explicitly not allowed to change the outcome.
 */
async function shutdown(code: number): Promise<never> {
	process.on("uncaughtException", (err) => {
		console.warn(
			`org-refresh status=shutdown_error error=${JSON.stringify(String(err))}`,
		);
		process.exit(code);
	});
	await db?.$client.end({ timeout: 5 }).catch(() => {});
	process.exit(code);
}

function parseArgv(argv: string[]): {
	flags: Map<string, string | true>;
	logins: string[];
} {
	const flags = new Map<string, string | true>();
	const logins: string[] = [];
	for (const arg of argv) {
		if (!arg.startsWith("--")) {
			logins.push(arg);
			continue;
		}
		const [rawName, ...rest] = arg.slice(2).split("=");
		const name = rawName.trim();
		if (!name) throw new Error(`Invalid flag "${arg}".`);
		if (!VALID_FLAGS.has(name)) throw new Error(`Unknown flag "--${name}".`);
		flags.set(name, rest.length === 0 ? true : rest.join("="));
	}
	return { flags, logins };
}

function booleanFlag(flags: Map<string, string | true>, name: string): boolean {
	return flags.get(name) === true;
}

function isTrue(value: string | undefined): boolean {
	return value?.toLowerCase() === "true";
}

function numberValue(
	flags: Map<string, string | true>,
	name: string,
	envValue: string | undefined,
	fallback: number,
): number {
	const flagValue = flags.get(name);
	if (flagValue === true) throw new Error(`--${name} requires a value.`);
	const raw = typeof flagValue === "string" ? flagValue : envValue;
	if (raw == null || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`--${name} must be an integer >= 1.`);
	}
	return value;
}

function usage(): string {
	return [
		"Usage:",
		"  node .output/worker/refresh-orgs.mjs [flags]        # built image (the nightly run)",
		"  pnpm refresh:orgs [flags] [org…]                    # local source via tsx",
		"",
		"With no arguments: re-enumerate memberships due this month, then refresh every member row",
		"that predates the current month, round-robin across orgs. Naming orgs is a debug hatch —",
		"it refreshes all their members regardless of freshness and skips enumeration.",
		"",
		"Flags override env vars:",
		"  --dry-run                        env ORG_REFRESH_DRY_RUN",
		"  --max-requests=N                 env ORG_REFRESH_MAX_REQUESTS, default 3600",
		"  --max-enumerations=N             env ORG_REFRESH_MAX_ENUMERATIONS, default 100",
		"  --rate-per-hour=N                env ORG_REFRESH_RATE_PER_HOUR, default 1200",
		"  --remaining-floor=N              env ORG_REFRESH_REMAINING_FLOOR, default 500",
		"  --poll-every=N                   env ORG_REFRESH_POLL_EVERY, default 25",
		"  --member-pages=N                 env ORG_REFRESH_MEMBER_PAGES, default 60 (×100 members)",
		"  --max-runtime-minutes=N          env ORG_REFRESH_MAX_RUNTIME_MINUTES, default 240",
	].join("\n");
}
