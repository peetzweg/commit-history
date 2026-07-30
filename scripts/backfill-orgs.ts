/**
 * Fill organization lifetime totals in the background, a bounded slice at a time.
 *
 * Bundled by `pnpm build` into `.output/worker/backfill-orgs.mjs`, which is what the production
 * image runs as a Coolify scheduled task (daily, 06:00 UTC — deliberately clear of the monthly
 * user refresh, which runs on the 1st at 03:00 and takes a couple of hours):
 *
 *   node .output/worker/backfill-orgs.mjs
 *
 * Locally, `pnpm backfill:orgs` runs this source through tsx.
 *
 * The engine (src/lib/org-backfill.ts) is built to *not* finish: it spends at most
 * --max-requests GraphQL requests per run, keeps a floor of budget free for live site traffic,
 * stops on a wall-clock cap, and resumes from `org_members.last_fetched` next time. So a
 * 2,800-member org gets chipped away over several nights instead of blocking the queue, and every
 * org the site has ever recorded eventually gets filled.
 *
 * Execute-by-default. `--dry-run` reports what it would do without spending requests or writing.
 *
 *   node .output/worker/backfill-orgs.mjs                       # drain the queue, smallest org first
 *   pnpm backfill:orgs --dry-run                                # preview the slice
 *   pnpm backfill:orgs google microsoft                         # these orgs specifically
 *   pnpm backfill:orgs --force jupyter                          # re-fetch every member, don't resume
 *   pnpm backfill:orgs --stale-after-days=90 --max-stale-orgs=5 # refresh the 5 oldest built orgs
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
import { runOrgBackfill } from "#/lib/org-backfill";
import { createOrgBackfillStore } from "#/lib/org-backfill-store";

const VALID_FLAGS = new Set([
	"dry-run",
	"force",
	"h",
	"help",
	"max-orgs",
	"max-requests",
	"max-runtime-minutes",
	"max-stale-orgs",
	"member-pages",
	"poll-every",
	"rate-per-hour",
	"remaining-floor",
	"stale-after-days",
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
	env.ORG_BACKFILL_MAX_RUNTIME_MINUTES,
	120,
);

const result = await runOrgBackfill({
	store: createOrgBackfillStore(db),
	token: GITHUB_TOKEN,
	now: new Date(),
	logins,
	dryRun: booleanFlag(flags, "dry-run") || isTrue(env.ORG_BACKFILL_DRY_RUN),
	force: booleanFlag(flags, "force") || isTrue(env.ORG_BACKFILL_FORCE),
	maxOrgs: numberValue(flags, "max-orgs", env.ORG_BACKFILL_MAX_ORGS, 25),
	maxRequests: numberValue(
		flags,
		"max-requests",
		env.ORG_BACKFILL_MAX_REQUESTS,
		1500,
	),
	ratePerHour: numberValue(
		flags,
		"rate-per-hour",
		env.ORG_BACKFILL_RATE_PER_HOUR,
		1200,
	),
	remainingFloor: numberValue(
		flags,
		"remaining-floor",
		env.ORG_BACKFILL_REMAINING_FLOOR,
		500,
	),
	pollEvery: numberValue(flags, "poll-every", env.ORG_BACKFILL_POLL_EVERY, 25),
	memberPages: numberValue(
		flags,
		"member-pages",
		env.ORG_BACKFILL_MEMBER_PAGES,
		30,
	),
	staleAfterDays: numberValue(
		flags,
		"stale-after-days",
		env.ORG_BACKFILL_STALE_AFTER_DAYS,
		0,
		{ allowZero: true },
	),
	maxStaleOrgs: numberValue(
		flags,
		"max-stale-orgs",
		env.ORG_BACKFILL_MAX_STALE_ORGS,
		0,
		{ allowZero: true },
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
// in Coolify — so those two exit non-zero and show up as a failed execution.
const systemicFailure =
	result.stopReason === "consecutive_failures" ||
	(result.orgsFailed > 0 && result.membersFetched === 0 && !result.dryRun);

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
			`org-backfill status=shutdown_error error=${JSON.stringify(String(err))}`,
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
	opts: { allowZero?: boolean } = {},
): number {
	const flagValue = flags.get(name);
	if (flagValue === true) throw new Error(`--${name} requires a value.`);
	const raw = typeof flagValue === "string" ? flagValue : envValue;
	if (raw == null || raw === "") return fallback;
	const value = Number(raw);
	const floor = opts.allowZero ? 0 : 1;
	if (!Number.isInteger(value) || value < floor) {
		throw new Error(
			`--${name} must be an integer >= ${floor}${opts.allowZero ? " (0 disables it)" : ""}.`,
		);
	}
	return value;
}

function usage(): string {
	return [
		"Usage:",
		"  node .output/worker/backfill-orgs.mjs [flags] [org…]     # built image",
		"  pnpm backfill:orgs [flags] [org…]                        # local source via tsx",
		"",
		"Named orgs bypass the queue. With none, drains recorded-but-unfilled orgs, smallest first.",
		"",
		"Flags override env vars:",
		"  --dry-run                        env ORG_BACKFILL_DRY_RUN",
		"  --force                          env ORG_BACKFILL_FORCE",
		"  --max-orgs=N                     env ORG_BACKFILL_MAX_ORGS, default 25",
		"  --max-requests=N                 env ORG_BACKFILL_MAX_REQUESTS, default 1500",
		"  --rate-per-hour=N                env ORG_BACKFILL_RATE_PER_HOUR, default 1200",
		"  --remaining-floor=N              env ORG_BACKFILL_REMAINING_FLOOR, default 500",
		"  --poll-every=N                   env ORG_BACKFILL_POLL_EVERY, default 25",
		"  --member-pages=N                 env ORG_BACKFILL_MEMBER_PAGES, default 30 (×100 members)",
		"  --max-runtime-minutes=N          env ORG_BACKFILL_MAX_RUNTIME_MINUTES, default 120",
		"  --stale-after-days=N             env ORG_BACKFILL_STALE_AFTER_DAYS, default 0 (off)",
		"  --max-stale-orgs=N               env ORG_BACKFILL_MAX_STALE_ORGS, default 0 (off)",
	].join("\n");
}
