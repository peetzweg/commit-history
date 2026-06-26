/**
 * One-off backfill: populate the profile-metadata columns (followers, following, public_repos,
 * bio, company, location, website_url, twitter_username) for entities that predate them.
 *
 * Safe to re-run — it only touches `user` entities whose `followers` is NULL (i.e. never
 * backfilled) unless you pass `--all` to refresh every row. The same `user` query the app uses
 * (src/lib/github.ts fetchProfile) is replicated here so this can run as plain Node with no build.
 *
 *   node --env-file=.env scripts/backfill-profiles.mjs        # only un-backfilled rows
 *   node --env-file=.env scripts/backfill-profiles.mjs --all  # refresh everyone
 */
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");

const refreshAll = process.argv.includes("--all");
const sql = neon(DATABASE_URL);

async function fetchProfile(login) {
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
			"User-Agent": "commit-history-backfill",
		},
		body: JSON.stringify({ query }),
	});
	const json = await res.json();
	if (json.errors?.length)
		throw new Error(json.errors.map((e) => e.message).join("; "));
	const u = json.data?.user;
	if (!u) throw new Error("user not found");
	return u;
}

const rows = refreshAll
	? await sql`select id, login from entities where kind = 'user' order by login`
	: await sql`select id, login from entities where kind = 'user' and followers is null order by login`;

console.log(`${rows.length} entit${rows.length === 1 ? "y" : "ies"} to backfill\n`);

let ok = 0;
let failed = 0;
for (const { id, login } of rows) {
	try {
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
		ok++;
		console.log(
			`✓ ${login.padEnd(24)} ${u.followers.totalCount.toLocaleString()} followers`,
		);
	} catch (e) {
		failed++;
		console.log(`✗ ${login.padEnd(24)} ${e.message}`);
	}
	// Gentle pacing — well under GitHub's GraphQL rate limit.
	await new Promise((r) => setTimeout(r, 250));
}

console.log(`\nDone. ${ok} updated, ${failed} failed.`);
