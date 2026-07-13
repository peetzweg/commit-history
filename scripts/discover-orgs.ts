/**
 * Discover organizations on GitHub and pre-record them (unbuilt) so they become look-up-able and
 * get filled later by backfill-orgs.ts. Companion to that script — kept separate on purpose.
 *
 * GitHub has NO endpoint that ranks orgs by public-member count (the Search API returns only
 * login/id, caps at 1,000 results, and won't sort or filter by member count). So we can't ask for
 * "biggest orgs" directly. Instead we:
 *   1. gather candidate org logins from the Search API (`type:org`, sorted by followers — the best
 *      prominence proxy; sorting by repos returns education/spam orgs),
 *   2. enrich each with fetchOrgProfile to get its ACTUAL public member count,
 *   3. filter (--min-members) and sort by that count, most members first,
 *   4. record the survivors as `entities` rows (kind='org', builtAt null).
 * backfill-orgs.ts then fills them (it fills smallest-first, so small ones resolve quickly).
 *
 * Needs the read:org token from .env (member counts require it), so prefix with env -u
 * GITHUB_TOKEN if your shell exports one:
 *
 *   env -u GITHUB_TOKEN bun scripts/discover-orgs.ts                  # top ~100 prominent orgs
 *   env -u GITHUB_TOKEN bun scripts/discover-orgs.ts --limit 300      # scan more candidates (max 1000)
 *   env -u GITHUB_TOKEN bun scripts/discover-orgs.ts --min-members 50 # only record sizeable orgs
 *   env -u GITHUB_TOKEN bun scripts/discover-orgs.ts --query "type:org location:berlin"
 *   env -u GITHUB_TOKEN bun scripts/discover-orgs.ts --dry-run        # preview, write nothing
 *
 * Idempotent: already-known orgs are skipped before enrichment; recording is an upsert. Afterwards:
 *   env -u GITHUB_TOKEN bun scripts/backfill-orgs.ts                  # fills the newly-recorded orgs
 */
import { inArray } from "drizzle-orm";
import { db } from "#/lib/db";
import { entities } from "#/lib/db/schema";
import { fetchOrgProfile, type OrgProfile } from "#/lib/github";

if (!process.env.DATABASE_URL)
	throw new Error("DATABASE_URL is required (add it to .env)");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required (add it to .env)");
if (!db) throw new Error("Database client failed to initialise.");
const token = GITHUB_TOKEN;
const database = db;

const orgEntityId = (login: string) => `org:${login.trim().toLowerCase()}`;

const argv = process.argv.slice(2);
const argValue = (name: string, fallback: string): string => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
// GitHub's Search API never returns more than 1,000 results for a query.
const LIMIT = Math.min(1000, Math.max(1, Number(argValue("--limit", "100"))));
const MIN_MEMBERS = Math.max(0, Number(argValue("--min-members", "0")));
const QUERY = argValue("--query", "type:org");
const DRY_RUN = argv.includes("--dry-run");

const REMAINING_FLOOR = 500;
const SEARCH_PER_PAGE = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Query GitHub's GraphQL rate-limit budget (the enrichment path spends GraphQL points). */
async function graphqlRemaining(): Promise<number | null> {
	try {
		const res = await fetch("https://api.github.com/graphql", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "commit-history-discover-orgs",
			},
			body: JSON.stringify({ query: "query { rateLimit { remaining resetAt } }" }),
		});
		const json = (await res.json()) as {
			data?: { rateLimit: { remaining: number; resetAt: string } };
		};
		const rl = json.data?.rateLimit;
		if (!rl) return null;
		if (rl.remaining <= REMAINING_FLOOR) {
			const waitMs =
				Math.max(0, new Date(rl.resetAt).getTime() - Date.now()) + 2000;
			console.log(
				`… GraphQL budget low (${rl.remaining}) — pausing ${Math.ceil(waitMs / 1000)}s`,
			);
			await sleep(waitMs);
		}
		return rl.remaining;
	} catch {
		return null;
	}
}

/** Page the Search API for org logins, prominence-first. Stops at `limit`, the 1,000 cap, or the
 *  end of results. Paced under the 30-searches/minute limit. */
async function searchOrgLogins(query: string, limit: number): Promise<string[]> {
	const logins: string[] = [];
	const pages = Math.ceil(limit / SEARCH_PER_PAGE);
	for (let page = 1; page <= pages; page++) {
		const url = `https://api.github.com/search/users?q=${encodeURIComponent(query)}&sort=followers&order=desc&per_page=${SEARCH_PER_PAGE}&page=${page}`;
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "commit-history-discover-orgs",
			},
		});
		// 422 = asked past the 1,000-result cap; nothing more to page.
		if (res.status === 422) break;
		if (res.status === 403 || res.status === 429) {
			const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
			const waitMs = Math.max(5000, reset - Date.now()) + 1000;
			console.log(`… search rate-limited — waiting ${Math.ceil(waitMs / 1000)}s`);
			await sleep(waitMs);
			page--; // retry this page
			continue;
		}
		if (!res.ok) {
			throw new Error(`GitHub search failed: ${res.status} ${await res.text()}`);
		}
		const json = (await res.json()) as { items?: { login: string }[] };
		const items = json.items ?? [];
		for (const it of items) if (it.login) logins.push(it.login);
		if (items.length < SEARCH_PER_PAGE) break; // ran out of results
		if (logins.length >= limit) break;
		await sleep(2500); // stay comfortably under 30 searches/min
	}
	return logins.slice(0, limit);
}

const candidates = await searchOrgLogins(QUERY, LIMIT);
console.log(
	`Discovered ${candidates.length} candidate org(s) via search "${QUERY}" (followers-first)`,
);
if (candidates.length === 0) process.exit(0);

// Skip orgs we already track — no point enriching or re-recording them.
const ids = candidates.map(orgEntityId);
const knownRows = await database
	.select({ id: entities.id })
	.from(entities)
	.where(inArray(entities.id, ids));
const known = new Set(knownRows.map((r) => r.id));
const fresh = candidates.filter((l) => !known.has(orgEntityId(l)));
console.log(
	`${known.size} already tracked, ${fresh.length} new — fetching member counts…\n`,
);

// Enrich: one profile fetch per candidate gives the real public member count.
const profiles: OrgProfile[] = [];
for (const login of fresh) {
	await graphqlRemaining();
	try {
		profiles.push(await fetchOrgProfile(login, token));
	} catch (e) {
		// 404/400 = gone or a login we can't query; transient errors we just skip for this org
		// rather than aborting the whole discovery run.
		console.log(
			`  ! ${login.padEnd(24)} skipped — ${(e as Error).message.slice(0, 60)}`,
		);
	}
	await sleep(120);
}

const selected = profiles
	.filter((p) => p.memberCount >= MIN_MEMBERS)
	.sort((a, b) => b.memberCount - a.memberCount);

console.log(
	`\n${selected.length} org(s)${MIN_MEMBERS ? ` with ≥${MIN_MEMBERS} public members` : ""}, most members first:`,
);
for (const p of selected) {
	console.log(`  ${p.memberCount.toLocaleString().padStart(6)}  ${p.login}`);
}

if (DRY_RUN) {
	console.log("\n--dry-run: nothing written.");
	process.exit(0);
}

// Record as unbuilt org rows (builtAt null) so backfill-orgs.ts picks them up.
let recorded = 0;
for (const p of selected) {
	const cols = {
		login: p.login,
		name: p.name,
		avatarUrl: p.avatarUrl,
		htmlUrl: p.htmlUrl,
		createdAt: new Date(p.createdAt),
		bio: p.description,
		location: p.location,
		websiteUrl: p.websiteUrl,
		twitterUsername: p.twitterUsername,
		publicRepos: p.publicRepos,
		isVerified: p.isVerified,
		githubNodeId: p.nodeId,
		memberCount: p.memberCount,
		lastFetched: new Date(),
	};
	await database
		.insert(entities)
		.values({ id: orgEntityId(p.login), kind: "org", ...cols })
		.onConflictDoUpdate({ target: entities.id, set: cols });
	recorded++;
}
console.log(
	`\nRecorded ${recorded} org(s) (builtAt null). Fill them next:\n  env -u GITHUB_TOKEN bun scripts/backfill-orgs.ts`,
);
