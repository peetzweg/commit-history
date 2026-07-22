/**
 * Full refresh of ONE user login — a complete rebuild from GitHub, not a trailing-month refresh.
 *
 * Why this exists: the cache treats completed past months as immutable (see src/lib/cache.ts) and
 * never re-fetches them. So when someone flips on GitHub's "Include private contributions on my
 * profile", every historical month's private-contribution count changes retroactively, but neither
 * a normal lookup nor `pnpm refresh` (profile metadata only) will ever notice. This forces a
 * month-by-month rebuild via the SAME code path the app uses (fetchCommitHistory) and overwrites
 * every stored month + the lifetime totals, so the newly-revealed private contributions land.
 *
 * Unlike `pnpm backfill <login>`, this seeds a login that has never been looked up, and reports the
 * before→after private-contribution diff so you can see what opened up. For a bulk sweep of every
 * user, still use `pnpm backfill --all` (it paces itself under GitHub's rate limit).
 *
 * Run with bun, which auto-loads the local (un-committed) `.env`, so no `--env-file` flag:
 *
 *   bun run refresh-user <login>
 */
import { eq, sql } from "drizzle-orm";
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

const [rawLogin] = process.argv.slice(2);
if (!rawLogin || rawLogin.startsWith("--")) {
	console.log("Usage:\n  bun run refresh-user <login>   full rebuild of one account");
	process.exit(1);
}

const id = `user:${rawLogin.trim().toLowerCase()}`;

// "Before" snapshot — null when the login has never been looked up (we'll seed it).
const [before] = await database
	.select({
		login: entities.login,
		totalCommits: entities.totalCommits,
		totalRestricted: entities.totalRestricted,
	})
	.from(entities)
	.where(eq(entities.id, id))
	.limit(1);

if (before) {
	console.log(
		`Rebuilding ${before.login} — currently ${before.totalCommits.toLocaleString()} commits, ${before.totalRestricted.toLocaleString()} private`,
	);
} else {
	console.log(`"${rawLogin}" not in the database yet — seeding a fresh build.`);
}

// Full rebuild via the app's own code path. Throws a GitHubError (404) on an unknown login.
const history = await fetchCommitHistory(rawLogin, token);
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

// Stamp the entity: profile + all lifetime totals + builtAt (this row is now fully built).
await database
	.insert(entities)
	.values({
		id,
		kind: "user",
		login: user.login,
		name: user.name,
		avatarUrl: user.avatarUrl,
		htmlUrl: `https://github.com/${user.login}`,
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
	.onConflictDoUpdate({
		target: entities.id,
		set: {
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
		},
	});

// Overwrite every month. Windows are deterministic from createdAt, so an upsert covers the whole
// series — there are no stale rows to delete.
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

const restrictedDelta = totalRestricted - (before?.totalRestricted ?? 0);
const sign = restrictedDelta >= 0 ? "+" : "";
console.log(
	`✓ ${user.login} rebuilt — ${total.toLocaleString()} commits · ${totalRestricted.toLocaleString()} private (${sign}${restrictedDelta.toLocaleString()}) · ${points.length} months`,
);

// postgres.js keeps its pool open — close it or the script never exits.
await database.$client.end();
