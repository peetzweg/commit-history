/**
 * Refresh the newest completed contribution month for visible leaderboard users.
 *
 * Bundled by `pnpm build` into `.output/worker/monthly-user-refresh.mjs`, which is what the
 * production image runs as a Coolify scheduled task:
 *
 *   node .output/worker/monthly-user-refresh.mjs
 *
 * Locally, `pnpm monthly:user` runs this source directly through tsx.
 *
 * Execute-by-default. Use `--dry-run` to inspect the candidate set without spending GitHub API
 * requests or writing rows. Current/future months require `--allow-incomplete-month`.
 */
import { db } from "#/lib/db";
import { fetchMonthlyCommits, fetchRateLimitBudget } from "#/lib/github";
import {
	runMonthlyUserRefresh,
	USER_REFRESH_METRICS,
	type UserRefreshMetric,
} from "#/lib/monthly-user-refresh";
import { createMonthlyUserRefreshStore } from "#/lib/monthly-user-refresh-store";

const VALID_FLAGS = new Set([
	"allow-incomplete-month",
	"dry-run",
	"h",
	"help",
	"limit-per-metric",
	"max-users",
	"max-runtime-minutes",
	"metrics",
	"poll-every",
	"rate-per-hour",
	"remaining-floor",
	"safe-after-utc",
	"target-month",
]);

const config = parseConfig(process.argv.slice(2), process.env);

if (config.help) {
	console.log(usage());
	process.exit(0);
}

const DATABASE_URL = process.env.DATABASE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required.");
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required.");
if (!db) throw new Error("Database client failed to initialise.");

await runMonthlyUserRefresh({
	store: createMonthlyUserRefreshStore(db),
	token: GITHUB_TOKEN,
	now: new Date(),
	targetMonth: config.targetMonth,
	safeAfterUtc: config.safeAfterUtc,
	metrics: config.metrics,
	limitPerMetric: config.limitPerMetric,
	maxUsers: config.maxUsers,
	ratePerHour: config.ratePerHour,
	maxRuntimeMs: config.maxRuntimeMinutes * 60_000,
	dryRun: config.dryRun,
	allowIncompleteMonth: config.allowIncompleteMonth,
	remainingFloor: config.remainingFloor,
	pollEvery: config.pollEvery,
	// The token is shared with live site traffic, so the run polls its own GraphQL budget and
	// refuses to spend below the floor. `rateLimit` queries cost 0 points.
	fetchRateLimit: () => fetchRateLimitBudget(GITHUB_TOKEN),
	fetchMonthlyCommits,
	logger: console,
});

await db.$client.end();
process.exit(0);

interface Config {
	help: boolean;
	dryRun: boolean;
	allowIncompleteMonth: boolean;
	targetMonth?: string;
	safeAfterUtc: string;
	limitPerMetric: number;
	maxUsers?: number;
	ratePerHour: number;
	maxRuntimeMinutes: number;
	remainingFloor: number;
	pollEvery: number;
	metrics: UserRefreshMetric[];
}

function parseConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
	const flags = parseFlags(argv);
	const metrics = stringValue(flags, "metrics", env.MONTHLY_USER_METRICS);
	return {
		help: booleanFlag(flags, "help") || booleanFlag(flags, "h"),
		dryRun:
			booleanFlag(flags, "dry-run") ||
			env.MONTHLY_USER_DRY_RUN?.toLowerCase() === "true",
		allowIncompleteMonth:
			booleanFlag(flags, "allow-incomplete-month") ||
			env.MONTHLY_USER_ALLOW_INCOMPLETE_MONTH?.toLowerCase() === "true",
		targetMonth: stringValue(flags, "target-month", env.MONTHLY_USER_TARGET_MONTH),
		safeAfterUtc: stringValue(
			flags,
			"safe-after-utc",
			env.MONTHLY_USER_SAFE_AFTER_UTC,
		) ?? "03:00",
		limitPerMetric: numberValue(
			flags,
			"limit-per-metric",
			env.MONTHLY_USER_LIMIT_PER_METRIC,
			500,
		),
		maxUsers: optionalNumberValue(flags, "max-users", env.MONTHLY_USER_MAX_USERS),
		ratePerHour: numberValue(
			flags,
			"rate-per-hour",
			env.MONTHLY_USER_RATE_PER_HOUR,
			1000,
		),
		maxRuntimeMinutes: numberValue(
			flags,
			"max-runtime-minutes",
			env.MONTHLY_USER_MAX_RUNTIME_MINUTES,
			360,
		),
		remainingFloor: numberValue(
			flags,
			"remaining-floor",
			env.MONTHLY_USER_REMAINING_FLOOR,
			500,
		),
		pollEvery: numberValue(flags, "poll-every", env.MONTHLY_USER_POLL_EVERY, 25),
		metrics: parseMetrics(metrics),
	};
}

function parseFlags(argv: string[]): Map<string, string | true> {
	const flags = new Map<string, string | true>();
	for (const arg of argv) {
		if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}".`);
		const [rawName, ...rest] = arg.slice(2).split("=");
		const name = rawName.trim();
		if (!name) throw new Error(`Invalid flag "${arg}".`);
		if (!VALID_FLAGS.has(name)) throw new Error(`Unknown flag "--${name}".`);
		flags.set(name, rest.length === 0 ? true : rest.join("="));
	}
	return flags;
}

function booleanFlag(flags: Map<string, string | true>, name: string): boolean {
	return flags.get(name) === true;
}

function stringValue(
	flags: Map<string, string | true>,
	name: string,
	envValue: string | undefined,
): string | undefined {
	const value = flags.get(name);
	if (typeof value === "string") return value;
	if (value === true) throw new Error(`--${name} requires a value.`);
	return envValue;
}

function optionalNumberValue(
	flags: Map<string, string | true>,
	name: string,
	envValue: string | undefined,
): number | undefined {
	const raw = stringValue(flags, name, envValue);
	if (raw == null || raw === "") return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`--${name} must be a positive integer.`);
	}
	return value;
}

function numberValue(
	flags: Map<string, string | true>,
	name: string,
	envValue: string | undefined,
	fallback: number,
): number {
	const raw = stringValue(flags, name, envValue);
	if (raw == null || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`--${name} must be a positive integer.`);
	}
	return value;
}

function parseMetrics(raw: string | undefined): UserRefreshMetric[] {
	if (!raw) return [...USER_REFRESH_METRICS];
	const valid = new Set<string>(USER_REFRESH_METRICS);
	const metrics = raw
		.split(",")
		.map((m) => m.trim())
		.filter(Boolean);
	for (const metric of metrics) {
		if (!valid.has(metric)) {
			throw new Error(
				`Invalid metric "${metric}". Use one of: ${USER_REFRESH_METRICS.join(", ")}`,
			);
		}
	}
	return metrics as UserRefreshMetric[];
}

function usage(): string {
	return [
		"Usage:",
		"  node .output/worker/monthly-user-refresh.mjs [flags]      # built image",
		"  pnpm monthly:user [flags]                                 # local source via tsx",
		"",
		"Flags override env vars:",
		"  --dry-run",
		"  --allow-incomplete-month          env MONTHLY_USER_ALLOW_INCOMPLETE_MONTH",
		"  --target-month=YYYY-MM-01          env MONTHLY_USER_TARGET_MONTH",
		"  --safe-after-utc=HH:MM             env MONTHLY_USER_SAFE_AFTER_UTC, default 03:00",
		"  --limit-per-metric=N               env MONTHLY_USER_LIMIT_PER_METRIC, default 500",
		"  --max-users=N                      env MONTHLY_USER_MAX_USERS",
		"  --rate-per-hour=N                  env MONTHLY_USER_RATE_PER_HOUR, default 1000",
		"  --remaining-floor=N                env MONTHLY_USER_REMAINING_FLOOR, default 500",
		"  --poll-every=N                     env MONTHLY_USER_POLL_EVERY, default 25",
		"  --max-runtime-minutes=N            env MONTHLY_USER_MAX_RUNTIME_MINUTES, default 360",
		"  --metrics=public,prs,...           env MONTHLY_USER_METRICS",
	].join("\n");
}
