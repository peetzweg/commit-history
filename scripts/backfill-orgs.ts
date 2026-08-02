/**
 * Lifetime-totals backfill for organizations the request path won't build on demand.
 *
 * After #103, an org with more than MAX_ORG_MEMBERS (25) public members is *recorded* on lookup
 * (an `entities` row, `builtAt` null) but never built live — building a mega-org on a page request
 * would burn the shared token's hourly budget. This script fills those recorded-but-empty orgs
 * (and any org you name explicitly, e.g. google/microsoft/github) with the SAME numbers the
 * request path produces for small orgs: each public member's lifetime contributions *to that org*,
 * summed. It writes only the existing tables — `org_members` rows + the `entities` roll-up — so it
 * needs NO database migration. (The per-month resolution / company chart is separate future work
 * on the refresh-orgs worker; this deliberately does none of that.)
 *
 * The per-org work itself lives in src/lib/org-refresh.ts, shared with `pnpm refresh-org` — this
 * script is the bulk driver (which orgs, in what order, at what pace); that module is the engine.
 * To refresh ONE org on demand, reach for `pnpm refresh-org` instead.
 *
 * Politeness: paced well under GitHub's 5,000 points/hour with a reserved floor for live traffic,
 * same model as backfill-contributions.ts. Run with bun (auto-loads .env; beware a shell-exported
 * GITHUB_TOKEN overriding it — prefix with `env -u GITHUB_TOKEN` if your shell sets one):
 *
 *   bun scripts/backfill-orgs.ts                       # every recorded org not yet filled, SMALLEST first
 *   bun scripts/backfill-orgs.ts google microsoft      # these orgs specifically (records them if new)
 *   bun scripts/backfill-orgs.ts --force <login…>      # re-fetch every member (refresh, don't resume)
 *
 * No-arg runs go smallest-org-first (fewest public members) so small orgs resolve quickly and
 * mega-orgs fall to the back instead of blocking everyone behind one 1,000-member org.
 *
 * Safe to re-run and interrupt: every write is an idempotent upsert; a member's `lastFetched`
 * marks it done, so a re-run SKIPS members already fetched (in this run or a previous, aborted
 * one) and continues from where it stopped. An org's `builtAt` is stamped only after all its
 * members are fetched, so an interrupted org stays unfilled and is picked up again. Pass --force
 * to re-fetch already-filled members (refresh their numbers) instead of resuming.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/lib/db";
import { entities } from "#/lib/db/schema";
import { refreshOrg, respectRateFloor } from "#/lib/org-refresh";

if (!process.env.DATABASE_URL)
	throw new Error("DATABASE_URL is required (add it to .env)");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required (add it to .env)");
if (!db) throw new Error("Database client failed to initialise.");
const token = GITHUB_TOKEN;
const database = db;

// Requests/hour we aim to spend (≈ GraphQL points), well under the 5,000/hr limit so the live
// site keeps working. Override with REFRESH_RATE=<n>.
const TARGET_RATE = Number(process.env.REFRESH_RATE ?? 2500);
// --force re-fetches every member even if already filled (to refresh numbers). Default: resume,
// i.e. skip members that already have a lastFetched from any prior run.
const force = process.argv.slice(2).includes("--force");

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));

let targets: { login: string }[];
if (args.length > 0) {
	targets = args.map((login) => ({ login }));
	console.log(`Backfilling ${targets.length} org(s) by name\n`);
} else {
	// Every recorded-but-unfilled org (builtAt null), SMALLEST first (fewest public members) so
	// small orgs resolve quickly and mega-orgs (microsoft, google) fall to the back instead of
	// blocking everyone. An org interrupted mid-fill still has builtAt null, so it's picked up
	// again and resumes from where it stopped (members already fetched are skipped).
	const rows = await database
		.select({ login: entities.login })
		.from(entities)
		.where(and(eq(entities.kind, "org"), isNull(entities.builtAt)))
		.orderBy(sql`${entities.memberCount} asc nulls last`, asc(entities.id));
	targets = rows;
	console.log(
		`${rows.length} recorded org(s) not yet filled, smallest first, ~${TARGET_RATE} req/hr\n`,
	);
}

let spent = 0;
for (const { login } of targets) {
	await respectRateFloor(token, console.log);
	try {
		const r = await refreshOrg({
			database,
			token,
			login,
			force,
			ratePerHour: TARGET_RATE,
			log: console.log,
		});
		spent += r.requests;
		console.log(
			`✓ ${r.login.padEnd(24)} ${r.after.totalCommits.toLocaleString()} commits · ` +
				`${r.fetched} fetched${r.skipped ? ` + ${r.skipped} already done` : ""} / ${r.tracked} members`,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`✗ ${login.padEnd(24)} ${msg} — continuing`);
	}
}
console.log(`\nDone. ~${spent.toLocaleString()} requests spent.`);
