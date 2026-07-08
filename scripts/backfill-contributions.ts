/**
 * Backfill the additional public contribution types — issues opened, PRs opened, PR reviews, and
 * repositories created — onto every entity's monthly history and lifetime totals.
 *
 * These columns didn't exist when older rows were cached, so their per-month values sit at 0 and
 * the entity-level totals (total_issues, …) are NULL until filled. This script does a full rebuild
 * per user via the SAME code path the app uses (fetchCommitHistory), then upserts the result —
 * so it also refreshes commits/private/profile as a side effect.
 *
 * Run with bun, which auto-loads the local (un-committed) `.env`, so no `--env-file` flag:
 *
 *   bun run backfill <login>   # one account
 *   bun run backfill           # only un-backfilled rows (total_issues IS NULL), top contributors first
 *   bun run backfill --all     # every user, top contributors first
 *
 * Politeness: the GitHub token is SHARED with the live site, so this paces itself well under
 * GitHub's 5,000 points/hour limit and never spends below a reserved floor (leaving headroom for
 * real traffic). Tune the target spend with BACKFILL_RATE (requests/hour, default 2500).
 *
 * Safe to re-run and interrupt: each finished user gets total_issues set, so the default mode
 * resumes on whatever is left. Highest-commit accounts are processed first, so the leaderboard and
 * most-viewed profiles are correct within the first stretch of a long run.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/lib/db";
import { entities, monthlyCommits } from "#/lib/db/schema";
import { fetchCommitHistory } from "#/lib/github";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!process.env.DATABASE_URL)
	throw new Error("DATABASE_URL is required (add it to .env)");
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required (add it to .env)");
if (!db) throw new Error("Database client failed to initialise.");
const token = GITHUB_TOKEN;
const database = db;

const entityId = (login: string) => `user:${login.trim().toLowerCase()}`;

// Requests/hour we aim to spend (≈ GraphQL points). Well under the 5,000/hr limit so the live
// site keeps working. Override with BACKFILL_RATE=<n>.
const TARGET_RATE = Number(process.env.BACKFILL_RATE ?? 2500);
// Never let the remaining budget drop below this — pure headroom for live traffic. If we ever get
// this low, we wait for GitHub's window to reset before continuing.
const REMAINING_FLOOR = 500;
// How often (in users) to poll the live rate-limit budget. The poll itself costs 0 points.
const POLL_EVERY = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RateLimit {
	remaining: number;
	resetAt: string;
}

/** Query GitHub's current rate-limit budget. `rateLimit` queries themselves cost 0 points. */
async function rateLimit(): Promise<RateLimit | null> {
	try {
		const res = await fetch("https://api.github.com/graphql", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "commit-history-backfill",
			},
			body: JSON.stringify({ query: "query { rateLimit { remaining resetAt } }" }),
		});
		const json = (await res.json()) as { data?: { rateLimit: RateLimit } };
		return json.data?.rateLimit ?? null;
	} catch {
		return null;
	}
}

/** If we're near the reserved floor, sleep until GitHub's window resets (plus a small buffer). */
async function respectFloor(): Promise<void> {
	const rl = await rateLimit();
	if (!rl) return;
	if (rl.remaining > REMAINING_FLOOR) return;
	const waitMs = Math.max(0, new Date(rl.resetAt).getTime() - Date.now()) + 2000;
	console.log(
		`… budget low (${rl.remaining} left) — pausing ${Math.ceil(waitMs / 1000)}s until reset`,
	);
	await sleep(waitMs);
}

async function backfill(id: string, login: string): Promise<{ log: string; requests: number }> {
	const history = await fetchCommitHistory(login, token);
	const {
		user,
		points,
		total,
		totalRestricted,
		totalIssues,
		totalPullRequests,
		totalReviews,
		totalRepos,
	} = history;
	const now = new Date();

	// Full-rebuild semantics: stamp builtAt + all lifetime totals (incl. the new types).
	await database
		.update(entities)
		.set({
			name: user.name,
			avatarUrl: user.avatarUrl,
			createdAt: new Date(user.createdAt),
			totalCommits: total,
			totalRestricted,
			totalIssues,
			totalPullRequests,
			totalReviews,
			totalRepos,
			followers: user.followers,
			following: user.following,
			publicRepos: user.publicRepos,
			bio: user.bio,
			company: user.company,
			location: user.location,
			websiteUrl: user.websiteUrl,
			twitterUsername: user.twitterUsername,
			lastFetched: now,
			builtAt: now,
		})
		.where(eq(entities.id, id));

	if (points.length > 0) {
		await database
			.insert(monthlyCommits)
			.values(
				points.map((p) => ({
					entityId: id,
					month: p.date,
					commits: p.commits,
					restricted: p.restricted,
					issues: p.issues,
					pullRequests: p.pullRequests,
					reviews: p.reviews,
					repos: p.repos,
				})),
			)
			.onConflictDoUpdate({
				target: [monthlyCommits.entityId, monthlyCommits.month],
				set: {
					commits: sql`excluded.commits`,
					restricted: sql`excluded.restricted`,
					issues: sql`excluded.issues`,
					pullRequests: sql`excluded.pull_requests`,
					reviews: sql`excluded.reviews`,
					repos: sql`excluded.repos`,
				},
			});
	}

	// 1 profile request + one batched request per 12 months.
	const requests = 1 + Math.ceil(points.length / 12);
	const log = `${total.toLocaleString()} commits · ${totalIssues.toLocaleString()} issues · ${totalPullRequests.toLocaleString()} PRs · ${totalReviews.toLocaleString()} reviews`;
	return { log, requests };
}

/** Process one user with a single rate-limit-aware retry, then pace to the target spend. */
async function processUser(id: string, login: string): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const { log, requests } = await backfill(id, login);
			console.log(`✓ ${login.padEnd(24)} ${log}`);
			// Politeness pacing: spread this user's request cost across the target hourly rate.
			await sleep((requests / TARGET_RATE) * 3_600_000);
			return true;
		} catch (e) {
			const msg = (e as Error).message;
			const rateLimited = /rate limit|secondary|403|429/i.test(msg);
			if (rateLimited && attempt === 0) {
				await respectFloor();
				continue; // retry the same user once after the window resets
			}
			console.log(`✗ ${login.padEnd(24)} ${msg}`);
			return false;
		}
	}
	return false;
}

const [arg1] = process.argv.slice(2);

if (arg1 && !arg1.startsWith("--")) {
	// One particular user.
	const id = entityId(arg1);
	const [row] = await database
		.select({ id: entities.id, login: entities.login })
		.from(entities)
		.where(eq(entities.id, id))
		.limit(1);
	if (!row) {
		console.error(
			`✗ "${arg1}" is not in the database yet — nobody has looked them up. Check the spelling.`,
		);
		process.exit(1);
	}
	await processUser(row.id, row.login);
} else if (!arg1 || arg1 === "--all") {
	// Highest-commit accounts first, so the most relevant profiles land early.
	// Users only — feeding an org row to fetchCommitHistory would just 404.
	const base = database
		.select({ id: entities.id, login: entities.login })
		.from(entities);
	const rows =
		arg1 === "--all"
			? await base
					.where(eq(entities.kind, "user"))
					.orderBy(desc(entities.totalCommits))
			: await base
					.where(and(eq(entities.kind, "user"), isNull(entities.totalIssues)))
					.orderBy(desc(entities.totalCommits));

	console.log(
		`${rows.length} entit${rows.length === 1 ? "y" : "ies"} to backfill` +
			(arg1 === "--all" ? " (all)" : " (un-backfilled only)") +
			`, top contributors first, ~${TARGET_RATE} req/hr\n`,
	);

	let ok = 0;
	let failed = 0;
	for (let i = 0; i < rows.length; i++) {
		if (i > 0 && i % POLL_EVERY === 0) await respectFloor();
		const { id, login } = rows[i];
		if (await processUser(id, login)) ok++;
		else failed++;
	}

	console.log(`\nDone. ${ok} backfilled, ${failed} failed.`);
} else {
	console.log(
		[
			"Usage:",
			"  bun run backfill <login>   backfill one account",
			"  bun run backfill           backfill only un-backfilled rows (total_issues IS NULL)",
			"  bun run backfill --all     backfill every user",
			"",
			"  BACKFILL_RATE=<n>          target requests/hour (default 2500, ceiling 5000)",
		].join("\n"),
	);
	process.exit(1);
}
