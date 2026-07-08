/**
 * Org ("company") background worker: seeds new orgs and upgrades existing ones from lifetime
 * totals to MONTHLY resolution — the data behind the company commit chart.
 *
 * The request path (org-cache.ts) deliberately stores lifetime totals only (~2 requests per
 * member). Monthly resolution costs ~12× that, so it lives here, paced well under GitHub's
 * 5,000 points/hour with a reserved floor for live traffic — same politeness model as
 * backfill-contributions.ts. Run with bun (auto-loads .env; beware a shell-exported
 * GITHUB_TOKEN overriding it — prefix with `env -u GITHUB_TOKEN` if your shell sets one):
 *
 *   bun scripts/refresh-orgs.ts                 # monthly-refresh every org, stalest first
 *   bun scripts/refresh-orgs.ts <login>         # one org
 *   bun scripts/refresh-orgs.ts --add <login…>  # seed new orgs (lifetime totals only)
 *
 * Per org: re-fetch the profile, re-enumerate members (new public members join as pending;
 * departed members' rows are KEPT with their last totals — see #97), then per member fetch
 * monthly org-scoped windows → org_member_monthly rows + refreshed org_members lifetime
 * totals. Finally roll up: org entity totals + org-level monthly_commits rows (the chart).
 *
 * Safe to re-run and interrupt: everything is an idempotent upsert, the org's lastFetched is
 * stamped only at the end (an interrupted org stays stalest and is retried first), and members
 * already refreshed in this run are skipped on resume.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "#/lib/db";
import {
	entities,
	monthlyCommits,
	orgMemberMonthly,
	orgMembers,
} from "#/lib/db/schema";
import {
	fetchOrgMembers,
	fetchOrgMemberWindows,
	fetchOrgProfile,
	GitHubError,
	monthlyWindows,
	type OrgMemberTotals,
} from "#/lib/github";
import { getOrgSummary } from "#/lib/org-cache";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!process.env.DATABASE_URL)
	throw new Error("DATABASE_URL is required (add it to .env)");
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required (add it to .env)");
if (!db) throw new Error("Database client failed to initialise.");
const token = GITHUB_TOKEN;
const database = db;

const orgEntityId = (login: string) => `org:${login.trim().toLowerCase()}`;
const userEntityId = (login: string) => `user:${login.trim().toLowerCase()}`;

// Requests/hour we aim to spend (≈ GraphQL points), well under the 5,000/hr limit so the live
// site keeps working. Override with REFRESH_RATE=<n>.
const TARGET_RATE = Number(process.env.REFRESH_RATE ?? 2500);
// Never let the remaining budget drop below this — headroom for live traffic.
const REMAINING_FLOOR = 500;
const CHUNK_ROWS = 100;

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
				"User-Agent": "commit-history-refresh-orgs",
			},
			body: JSON.stringify({
				query: "query { rateLimit { remaining resetAt } }",
			}),
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

const sumTotals = (windows: OrgMemberTotals[]): OrgMemberTotals =>
	windows.reduce(
		(acc, w) => ({
			commits: acc.commits + w.commits,
			issues: acc.issues + w.issues,
			pullRequests: acc.pullRequests + w.pullRequests,
			reviews: acc.reviews + w.reviews,
		}),
		{ commits: 0, issues: 0, pullRequests: 0, reviews: 0 },
	);

/** Monthly-refresh one org. Returns the (approximate) number of GitHub requests spent. */
async function refreshOrg(orgId: string, login: string): Promise<number> {
	const runStart = new Date();
	let requests = 0;

	// Profile first: refreshes the mutable metadata and guarantees nodeId/createdAt.
	const profile = await fetchOrgProfile(login, token);
	requests += 1;
	await database
		.update(entities)
		.set({
			login: profile.login,
			name: profile.name,
			avatarUrl: profile.avatarUrl,
			htmlUrl: profile.htmlUrl,
			createdAt: new Date(profile.createdAt),
			bio: profile.description,
			location: profile.location,
			websiteUrl: profile.websiteUrl,
			twitterUsername: profile.twitterUsername,
			publicRepos: profile.publicRepos,
			isVerified: profile.isVerified,
			githubNodeId: profile.nodeId,
			memberCount: profile.memberCount,
		})
		.where(eq(entities.id, orgId));
	const orgCreated = new Date(profile.createdAt);

	// Re-enumerate: new public members join as pending rows; departed rows are kept (#97).
	const members = await fetchOrgMembers(login, token);
	requests += Math.max(1, Math.ceil(members.length / 100));
	for (let i = 0; i < members.length; i += CHUNK_ROWS) {
		const chunk = members.slice(i, i + CHUNK_ROWS);
		await database
			.insert(entities)
			.values(
				chunk.map((m) => ({
					id: userEntityId(m.login),
					kind: "user",
					login: m.login,
					name: m.name,
					avatarUrl: m.avatarUrl,
					htmlUrl: `https://github.com/${m.login}`,
					createdAt: new Date(m.createdAt),
				})),
			)
			.onConflictDoNothing();
		await database
			.insert(orgMembers)
			.values(
				chunk.map((m) => ({
					orgId,
					memberId: userEntityId(m.login),
					role: m.role,
					source: "public_member",
				})),
			)
			.onConflictDoNothing();
	}
	const currentIds = new Set(members.map((m) => userEntityId(m.login)));
	const allRows = await database
		.select({ memberId: orgMembers.memberId, lastFetched: orgMembers.lastFetched })
		.from(orgMembers)
		.where(eq(orgMembers.orgId, orgId));
	const departed = allRows.filter((r) => !currentIds.has(r.memberId)).length;
	if (departed > 0) {
		console.log(`  keeping ${departed} departed member row(s) frozen (#97)`);
	}
	const lastFetchedById = new Map(
		allRows.map((r) => [r.memberId, r.lastFetched]),
	);

	for (const m of members) {
		const memberId = userEntityId(m.login);
		// Resume support: skip members already refreshed since this run started.
		const prev = lastFetchedById.get(memberId);
		if (prev && prev >= runStart) continue;

		const start = new Date(
			Math.max(orgCreated.getTime(), new Date(m.createdAt).getTime()),
		);
		const windows = monthlyWindows(start, runStart);
		let counts: OrgMemberTotals[];
		try {
			counts = await fetchOrgMemberWindows(m.login, profile.nodeId, token, windows);
		} catch (e) {
			// A deleted/renamed member 404s forever — record zeros and move on.
			if (!(e instanceof GitHubError && e.status === 404)) throw e;
			counts = [];
		}
		const req = Math.max(1, Math.ceil(windows.length / 6));
		requests += req;

		// Store active months only — absent rows read as zero when the chart assembles.
		const monthRows = windows
			.map((w, i) => ({
				orgId,
				memberId,
				month: w.label,
				commits: counts[i]?.commits ?? 0,
				pullRequests: counts[i]?.pullRequests ?? 0,
				reviews: counts[i]?.reviews ?? 0,
				issues: counts[i]?.issues ?? 0,
			}))
			.filter((r) => r.commits || r.pullRequests || r.reviews || r.issues);
		for (let i = 0; i < monthRows.length; i += CHUNK_ROWS) {
			await database
				.insert(orgMemberMonthly)
				.values(monthRows.slice(i, i + CHUNK_ROWS))
				.onConflictDoUpdate({
					target: [
						orgMemberMonthly.orgId,
						orgMemberMonthly.memberId,
						orgMemberMonthly.month,
					],
					set: {
						commits: sql`excluded.commits`,
						pullRequests: sql`excluded.pull_requests`,
						reviews: sql`excluded.reviews`,
						issues: sql`excluded.issues`,
					},
				});
		}
		const totals = sumTotals(counts);
		await database
			.update(orgMembers)
			.set({ ...totals, lastFetched: new Date() })
			.where(
				and(eq(orgMembers.orgId, orgId), eq(orgMembers.memberId, memberId)),
			);
		console.log(
			`  ✓ ${m.login.padEnd(24)} ${totals.commits.toLocaleString()} commits · ${monthRows.length} active months`,
		);
		// Politeness pacing: spread this member's request cost across the target hourly rate.
		await sleep((req / TARGET_RATE) * 3_600_000);
	}

	// Roll up: org entity totals from org_members (departed rows included, frozen — #97) and
	// org-level month rows from org_member_monthly (the company chart's data).
	const [sums] = await database
		.select({
			commits: sql<number>`coalesce(sum(${orgMembers.commits}), 0)`,
			pullRequests: sql<number>`coalesce(sum(${orgMembers.pullRequests}), 0)`,
			reviews: sql<number>`coalesce(sum(${orgMembers.reviews}), 0)`,
			issues: sql<number>`coalesce(sum(${orgMembers.issues}), 0)`,
		})
		.from(orgMembers)
		.where(eq(orgMembers.orgId, orgId));
	const monthly = await database
		.select({
			month: orgMemberMonthly.month,
			commits: sql<number>`sum(${orgMemberMonthly.commits})`,
			pullRequests: sql<number>`sum(${orgMemberMonthly.pullRequests})`,
			reviews: sql<number>`sum(${orgMemberMonthly.reviews})`,
			issues: sql<number>`sum(${orgMemberMonthly.issues})`,
		})
		.from(orgMemberMonthly)
		.where(eq(orgMemberMonthly.orgId, orgId))
		.groupBy(orgMemberMonthly.month);
	for (let i = 0; i < monthly.length; i += CHUNK_ROWS) {
		await database
			.insert(monthlyCommits)
			.values(
				monthly.slice(i, i + CHUNK_ROWS).map((r) => ({
					entityId: orgId,
					month: r.month,
					commits: Number(r.commits),
					pullRequests: Number(r.pullRequests),
					reviews: Number(r.reviews),
					issues: Number(r.issues),
				})),
			)
			.onConflictDoUpdate({
				target: [monthlyCommits.entityId, monthlyCommits.month],
				set: {
					commits: sql`excluded.commits`,
					pullRequests: sql`excluded.pull_requests`,
					reviews: sql`excluded.reviews`,
					issues: sql`excluded.issues`,
				},
			});
	}
	await database
		.update(entities)
		.set({
			totalCommits: Number(sums?.commits ?? 0),
			totalPullRequests: Number(sums?.pullRequests ?? 0),
			totalReviews: Number(sums?.reviews ?? 0),
			totalIssues: Number(sums?.issues ?? 0),
			builtAt: new Date(),
			lastFetched: new Date(),
		})
		.where(eq(entities.id, orgId));
	return requests;
}

/** Seed one new org via the same code path the site uses, looping the resumable build. */
async function seedOrg(login: string): Promise<boolean> {
	for (let i = 0; i < 200; i++) {
		try {
			const s = await getOrgSummary(login, token);
			console.log(
				`✓ ${login.padEnd(24)} ${s.totalCommits.toLocaleString()} commits · ${s.membersTracked} members`,
			);
			return true;
		} catch (e) {
			if (e instanceof GitHubError && e.status === 503) {
				await sleep(500); // budget slice done, progress persisted — continue immediately-ish
				continue;
			}
			// Too large for a live build (422): the request path still recorded the profile row,
			// so the org is now enrolled — `refreshOrg` (via --all or by name) builds it here,
			// paced, with no size cap. This is the intended path for mega-orgs like `google`.
			if (e instanceof GitHubError && e.status === 422) {
				console.log(
					`• ${login.padEnd(24)} enrolled — too large for a live build; run to index: bun scripts/refresh-orgs.ts ${login}`,
				);
				return true;
			}
			console.log(`✗ ${login.padEnd(24)} ${(e as Error).message}`);
			return false;
		}
	}
	console.log(`✗ ${login.padEnd(24)} did not converge — rerun to resume`);
	return false;
}

const args = process.argv.slice(2);

if (args[0] === "--add") {
	const logins = args.slice(1);
	if (logins.length === 0) {
		console.error("Usage: bun scripts/refresh-orgs.ts --add <login> [login…]");
		process.exit(1);
	}
	console.log(`Seeding ${logins.length} org(s) (lifetime totals only)\n`);
	let ok = 0;
	for (const login of logins) {
		await respectFloor();
		if (await seedOrg(login)) ok++;
	}
	console.log(`\nDone. ${ok}/${logins.length} seeded.`);
} else if (args[0] && !args[0].startsWith("--")) {
	const [row] = await database
		.select({ id: entities.id, login: entities.login })
		.from(entities)
		.where(eq(entities.id, orgEntityId(args[0])))
		.limit(1);
	if (!row) {
		console.error(
			`✗ "${args[0]}" is not a known org — seed it first: bun scripts/refresh-orgs.ts --add ${args[0]}`,
		);
		process.exit(1);
	}
	console.log(`Refreshing ${row.login} to monthly resolution…`);
	const requests = await refreshOrg(row.id, row.login);
	console.log(`Done (${requests} requests).`);
} else if (args.length === 0 || args[0] === "--all") {
	// Stalest first; an interrupted org keeps its old lastFetched and is retried first.
	const rows = await database
		.select({ id: entities.id, login: entities.login })
		.from(entities)
		.where(eq(entities.kind, "org"))
		.orderBy(sql`${entities.lastFetched} asc nulls first`, asc(entities.id));
	console.log(
		`${rows.length} org(s) to refresh to monthly resolution, stalest first, ~${TARGET_RATE} req/hr\n`,
	);
	let spent = 0;
	for (const row of rows) {
		await respectFloor();
		console.log(`${row.login}:`);
		try {
			spent += await refreshOrg(row.id, row.login);
		} catch (e) {
			console.log(`✗ ${row.login} failed: ${(e as Error).message} — continuing`);
		}
	}
	console.log(`\nDone. ~${spent.toLocaleString()} requests spent.`);
} else {
	console.log(
		[
			"Usage:",
			"  bun scripts/refresh-orgs.ts                 monthly-refresh every org, stalest first",
			"  bun scripts/refresh-orgs.ts <login>         one org",
			"  bun scripts/refresh-orgs.ts --add <login…>  seed new orgs (lifetime totals only)",
			"",
			"  REFRESH_RATE=<n>                            target requests/hour (default 2500)",
		].join("\n"),
	);
	process.exit(1);
}
