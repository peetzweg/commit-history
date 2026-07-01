/**
 * Backfill the additional public contribution types — issues opened, PRs opened, PR reviews, and
 * repositories created — onto every entity's monthly history and lifetime totals.
 *
 * These columns didn't exist when older rows were cached, so their per-month values sit at 0 and
 * the entity-level totals (total_issues, …) are NULL until filled. This script does a full rebuild
 * per user via the SAME code path the app uses (fetchCommitHistory), then upserts the result —
 * so it also refreshes commits/private/profile as a side effect. Mirrors scripts/refresh.ts.
 *
 * Run with bun, which auto-loads the local (un-committed) `.env`, so no `--env-file` flag:
 *
 *   bun run backfill <login>   # one account
 *   bun run backfill           # only un-backfilled rows (total_issues IS NULL), top contributors first
 *   bun run backfill --all     # every user, top contributors first
 *
 * Safe to re-run. Processes highest-commit accounts first so the most relevant profiles are done
 * early if the run is interrupted. Gentle pacing keeps us well under GitHub's GraphQL rate limit.
 */
import { desc, eq, isNull, sql } from "drizzle-orm";
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

// Delay between users. Each user costs ~1 + ceil(months/12) GraphQL requests (≈1 point each);
// this pacing keeps a long run comfortably under the 5,000 points/hour primary limit and avoids
// tripping secondary (burst) limits.
const DELAY_MS = 300;

async function backfill(id: string, login: string): Promise<string> {
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

	return `${total.toLocaleString()} commits · ${totalIssues.toLocaleString()} issues · ${totalPullRequests.toLocaleString()} PRs · ${totalReviews.toLocaleString()} reviews`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
	console.log(`${row.login} → ${await backfill(row.id, row.login)}`);
} else if (!arg1 || arg1 === "--all") {
	// Highest-commit accounts first, so the most relevant profiles land early.
	const base = database
		.select({ id: entities.id, login: entities.login })
		.from(entities);
	const rows =
		arg1 === "--all"
			? await base.orderBy(desc(entities.totalCommits))
			: await base
					.where(isNull(entities.totalIssues))
					.orderBy(desc(entities.totalCommits));

	console.log(
		`${rows.length} entit${rows.length === 1 ? "y" : "ies"} to backfill` +
			(arg1 === "--all" ? " (all)" : " (un-backfilled only)") +
			`, top contributors first\n`,
	);

	let ok = 0;
	let failed = 0;
	for (const { id, login } of rows) {
		try {
			const summary = await backfill(id, login);
			ok++;
			console.log(`✓ ${login.padEnd(24)} ${summary}`);
		} catch (e) {
			failed++;
			console.log(`✗ ${login.padEnd(24)} ${(e as Error).message}`);
		}
		await sleep(DELAY_MS);
	}

	console.log(`\nDone. ${ok} backfilled, ${failed} failed.`);
} else {
	console.log(
		[
			"Usage:",
			"  bun run backfill <login>   backfill one account",
			"  bun run backfill           backfill only un-backfilled rows (total_issues IS NULL)",
			"  bun run backfill --all     backfill every user",
		].join("\n"),
	);
	process.exit(1);
}
