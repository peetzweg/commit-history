/**
 * Refresh the profile-metadata columns (followers, following, public_repos, bio, company,
 * location, website_url, twitter_username, last_fetched) on `user` entities from GitHub.
 *
 * Run with bun, which auto-loads the local (un-committed) `.env`, so no `--env-file` flag:
 *
 *   bun run refresh <login>   # refresh one account
 *   bun run refresh           # refresh only un-backfilled rows (followers is null)
 *   bun run refresh --all     # refresh every user
 *
 * Safe to re-run. The same `user` query the app uses (src/lib/github.ts fetchProfile) is
 * replicated here so this runs as a plain script with no build step. Mirrors scripts/suspend.ts.
 */
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required (add it to .env)");
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required (add it to .env)");

// prepare: false — Neon's pooled endpoint is PgBouncer transaction mode (see src/lib/db).
const sql = postgres(DATABASE_URL, { prepare: false });

const entityId = (login: string) => `user:${login.trim().toLowerCase()}`;

async function fetchProfile(login: string) {
	const query = `query { user(login: "${login}") {
		login name avatarUrl createdAt bio company location websiteUrl twitterUsername
		followers { totalCount }
		following { totalCount }
		repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
	} }`;
	const res = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${GITHUB_TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "commit-history-refresh",
		},
		body: JSON.stringify({ query }),
	});
	const json = await res.json();
	if (json.errors?.length)
		throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "));
	const u = json.data?.user;
	if (!u) throw new Error("user not found");
	return u;
}

async function refresh(id: string, login: string) {
	const u = await fetchProfile(login);
	await sql`update entities set
		followers = ${u.followers.totalCount},
		following = ${u.following.totalCount},
		public_repos = ${u.repositories.totalCount},
		bio = ${u.bio},
		company = ${u.company},
		location = ${u.location},
		website_url = ${u.websiteUrl},
		twitter_username = ${u.twitterUsername},
		last_fetched = now()
	where id = ${id}`;
	console.log(
		`✓ ${login.padEnd(24)} ${u.followers.totalCount.toLocaleString()} followers`,
	);
}

const [arg1] = process.argv.slice(2);

if (arg1 && !arg1.startsWith("--")) {
	// Refresh one particular user.
	const id = entityId(arg1);
	const [row] = await sql`select id, login from entities where id = ${id}`;
	if (!row) {
		console.error(
			`✗ "${arg1}" is not in the database yet — nobody has looked them up. Check the spelling.`,
		);
		process.exit(1);
	}
	await refresh(row.id, row.login);
} else if (!arg1 || arg1 === "--all") {
	const rows =
		arg1 === "--all"
			? await sql`select id, login from entities where kind = 'user' order by login`
			: await sql`select id, login from entities where kind = 'user' and followers is null order by login`;

	console.log(`${rows.length} entit${rows.length === 1 ? "y" : "ies"} to refresh\n`);

	let ok = 0;
	let failed = 0;
	for (const { id, login } of rows) {
		try {
			await refresh(id, login);
			ok++;
		} catch (e) {
			failed++;
			console.log(`✗ ${login.padEnd(24)} ${(e as Error).message}`);
		}
		// Gentle pacing — well under GitHub's GraphQL rate limit.
		await new Promise((r) => setTimeout(r, 250));
	}

	console.log(`\nDone. ${ok} updated, ${failed} failed.`);
} else {
	console.log(
		[
			"Usage:",
			"  bun run refresh <login>   refresh one account",
			"  bun run refresh           refresh only un-backfilled rows",
			"  bun run refresh --all     refresh every user",
		].join("\n"),
	);
	process.exit(1);
}

// postgres.js keeps its pool open — close it or the script never exits.
await sql.end();
