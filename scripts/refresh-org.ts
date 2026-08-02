/**
 * On-demand refresh of ONE organization — the org sibling of `pnpm refresh-user`.
 *
 * Why this exists: an org's membership is enumerated **once**, when the org is first built (see
 * src/lib/org-cache.ts). Nothing on the request path ever re-reads `membersWithRole`, so a member
 * who joins later — or who flips their membership from private to public, the exact case in #150 —
 * never appears on the org page, no matter how many times anyone reloads it. This re-enumerates
 * the membership, fetches whatever is missing, and rolls the totals back up.
 *
 * By default it only fills gaps: brand-new members plus anyone a previous run left pending. That
 * makes the common case cheap (a 1,500-member org with one joiner costs ~2 requests, not ~3,000).
 * Pass --force to re-fetch every member's numbers as well, which is what you want when the org's
 * *existing* totals are stale rather than incomplete.
 *
 * Members who are no longer public are reported but kept — deleting them would silently shrink the
 * org's lifetime totals (#97).
 *
 * Run with bun, which auto-loads the local (un-committed) `.env`, so no `--env-file` flag. Beware
 * a shell-exported GITHUB_TOKEN overriding it — prefix with `env -u GITHUB_TOKEN` if your shell
 * sets one:
 *
 *   bun run refresh-org NixOS              # pick up new/pending members, roll up
 *   bun run refresh-org --force NixOS      # also re-fetch every member's numbers
 *   REFRESH_RATE=1200 bun run refresh-org NixOS   # pace slower (default 2500 req/hr)
 *
 * Safe to re-run and to interrupt: every write is an idempotent upsert and each member is stamped
 * as it lands, so a re-run resumes rather than restarting.
 */
import { db } from "#/lib/db";
import { refreshOrg, respectRateFloor } from "#/lib/org-refresh";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!process.env.DATABASE_URL)
	throw new Error("DATABASE_URL is required (add it to .env)");
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required (add it to .env)");
if (!db) throw new Error("Database client failed to initialise.");
const token = GITHUB_TOKEN;
const database = db;

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const logins = argv.filter((a) => !a.startsWith("-"));

if (logins.length === 0) {
	console.log(
		[
			"Usage:",
			"  bun run refresh-org <login…>            re-enumerate members, fill gaps, roll up",
			"  bun run refresh-org --force <login…>    also re-fetch every member's numbers",
			"",
			"  REFRESH_RATE=<n>  requests/hour to pace at (default 2500)",
		].join("\n"),
	);
	process.exit(1);
}

const ratePerHour = Number(process.env.REFRESH_RATE ?? 2500);
const delta = (n: number) => `${n >= 0 ? "+" : ""}${n.toLocaleString()}`;

let failed = 0;
for (const login of logins) {
	await respectRateFloor(token, console.log);
	try {
		const r = await refreshOrg({
			database,
			token,
			login,
			force,
			ratePerHour,
			log: console.log,
		});
		const commitDelta = r.after.totalCommits - (r.before?.totalCommits ?? 0);
		console.log(
			`✓ ${r.login} — ${r.after.totalCommits.toLocaleString()} commits (${delta(commitDelta)}) · ` +
				`${r.tracked.toLocaleString()}/${r.memberCount.toLocaleString()} members tracked · ` +
				`${r.added} added · ${r.fetched} fetched · ~${r.requests.toLocaleString()} requests`,
		);
		// We keep these rows, so `tracked` legitimately runs ahead of GitHub's count over time —
		// say so, otherwise the mismatch reads like the #150 bug all over again.
		if (r.departed.length > 0) {
			console.log(
				`  note: ${r.departed.length} tracked member(s) no longer public — kept, their contributions still count (#97)`,
			);
			if (r.departed.length <= 20) {
				console.log(`  ${r.departed.join(", ")}`);
			}
		}
	} catch (e) {
		failed++;
		console.log(
			`✗ ${login.padEnd(24)} ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

if (failed > 0) process.exitCode = 1;

// postgres.js keeps its pool open — close it or the script never exits.
await database.$client.end();
