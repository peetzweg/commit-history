import { eq, sql } from "drizzle-orm";
import { type DB, db } from "#/lib/db";
import { entities, lookups, monthlyCommits } from "#/lib/db/schema";
import {
	buildPoints,
	type CommitHistory,
	type CommitPoint,
	fetchCommitHistory,
	fetchMonthlyCommits,
	fetchProfile,
	type MonthlyCount,
	monthlyWindows,
	type Profile,
	sumContributionTypes,
} from "#/lib/github";

/**
 * Incremental commit-history cache.
 *
 * Completed past months never change, so a returning user only needs the trailing month(s)
 * re-fetched — turning a ~`months/12`-request lifetime fetch into a single small request.
 *
 * Storage is Neon Postgres when DATABASE_URL is set (durable + shared across instances), else a
 * per-process in-memory Map (so local dev / the app still work with no database).
 *
 * Two TTLs:
 *  - TAIL_TTL: how long a cached result is served untouched (no GitHub call at all).
 *  - FULL_TTL: after this, rebuild from scratch — catches *backfilled* history (rebases,
 *    repos made public, identity changes) that can alter long-past months.
 */
const TAIL_TTL = 60_000; // 1 min
const FULL_TTL = 7 * 24 * 60 * 60_000; // 7 days

export async function getCommitHistory(
	login: string,
	token: string,
	now = new Date(),
): Promise<CommitHistory> {
	if (!token) {
		// Defer to the uncached path so it throws the canonical "missing token" error.
		return fetchCommitHistory(login, token);
	}
	return db
		? getFromDb(db, login, token, now)
		: getFromMemory(login, token, now);
}

/** Recompute a series' tail from `tail`, splicing it onto the months before it. */
function applyTail(
	prevPoints: CommitPoint[],
	profile: Profile,
	tailWindows: { label: string }[],
	tail: MonthlyCount[],
): CommitHistory {
	const tailKeys = new Set(tailWindows.map((w) => w.label));
	const head = prevPoints.filter((p) => !tailKeys.has(p.date));
	let cumulative = head.at(-1)?.cumulative ?? 0;
	let restrictedCumulative = head.at(-1)?.restrictedCumulative ?? 0;
	const tailPoints: CommitPoint[] = tailWindows.map((w, i) => {
		const m = tail[i];
		const commits = m?.commits ?? 0;
		const restricted = m?.restricted ?? 0;
		cumulative += commits;
		restrictedCumulative += restricted;
		return {
			date: w.label,
			commits,
			cumulative,
			restricted,
			restrictedCumulative,
			issues: m?.issues ?? 0,
			pullRequests: m?.pullRequests ?? 0,
			reviews: m?.reviews ?? 0,
			repos: m?.repos ?? 0,
		};
	});
	const points = [...head, ...tailPoints];
	const last = points.at(-1);
	return {
		user: profile,
		points,
		total: last?.cumulative ?? 0,
		totalRestricted: last?.restrictedCumulative ?? 0,
		...sumContributionTypes(points),
	};
}

// ── Neon-backed store ────────────────────────────────────────────────────────

function entityId(login: string) {
	return `user:${login.trim().toLowerCase()}`;
}

async function getFromDb(
	database: DB,
	login: string,
	token: string,
	now: Date,
): Promise<CommitHistory> {
	const id = entityId(login);
	const nowMs = now.getTime();

	let row: typeof entities.$inferSelect | undefined;
	try {
		[row] = await database
			.select()
			.from(entities)
			.where(eq(entities.id, id))
			.limit(1);
	} catch {
		// DB read failed — degrade to a direct fetch so the page still renders.
		return fetchCommitHistory(login, token);
	}

	// Cold or stale → full rebuild.
	if (!row || !row.builtAt || nowMs - row.builtAt.getTime() > FULL_TTL) {
		const history = await fetchCommitHistory(login, token);
		await persist(database, id, history, now, true);
		await recordLookup(database, id, now);
		return history;
	}

	// Reconstruct the cached series from stored months.
	const rows = await database
		.select()
		.from(monthlyCommits)
		.where(eq(monthlyCommits.entityId, id));
	const byMonth = new Map<string, MonthlyCount>(
		rows.map((r) => [
			r.month,
			{
				commits: r.commits,
				restricted: r.restricted,
				issues: r.issues,
				pullRequests: r.pullRequests,
				reviews: r.reviews,
				repos: r.repos,
			},
		]),
	);
	const profile: Profile = {
		login: row.login,
		name: row.name,
		avatarUrl: row.avatarUrl ?? "",
		createdAt: (row.createdAt ?? now).toISOString(),
		bio: row.bio,
		company: row.company,
		location: row.location,
		websiteUrl: row.websiteUrl,
		twitterUsername: row.twitterUsername,
		followers: row.followers ?? 0,
		following: row.following ?? 0,
		publicRepos: row.publicRepos ?? 0,
	};
	const windows = monthlyWindows(row.createdAt ?? now, now);
	const emptyMonth: MonthlyCount = {
		commits: 0,
		restricted: 0,
		issues: 0,
		pullRequests: 0,
		reviews: 0,
		repos: 0,
	};
	const points = buildPoints(
		windows,
		windows.map((w) => byMonth.get(w.label) ?? emptyMonth),
	);
	const last = points.at(-1);
	const cached: CommitHistory = {
		user: profile,
		points,
		total: last?.cumulative ?? 0,
		totalRestricted: last?.restrictedCumulative ?? 0,
		...sumContributionTypes(points),
	};

	// Fresh enough → serve untouched.
	if (row.lastFetched && nowMs - row.lastFetched.getTime() < TAIL_TTL) {
		await recordLookup(database, id, now);
		return cached;
	}

	// Trailing refresh: re-fetch only the last cached month → now.
	const lastLabel = cached.points.at(-1)?.date;
	const tailStart = lastLabel
		? new Date(`${lastLabel}T00:00:00Z`)
		: (row.createdAt ?? now);
	const tailWindows = monthlyWindows(tailStart, now);

	let history: CommitHistory;
	try {
		const tailCommits = await fetchMonthlyCommits(login, token, tailWindows);
		let profileNext = profile;
		try {
			profileNext = await fetchProfile(login, token);
		} catch {
			/* keep cached profile */
		}
		history = applyTail(cached.points, profileNext, tailWindows, tailCommits);
		await persist(database, id, history, now, false);
	} catch {
		// Network hiccup on refresh: serve what we have.
		history = cached;
	}
	await recordLookup(database, id, now);
	return history;
}

/** Upsert the entity + its months. `fullRebuild` also stamps builtAt (else it's left intact). */
async function persist(
	database: DB,
	id: string,
	history: CommitHistory,
	now: Date,
	fullRebuild: boolean,
) {
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
	try {
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
					totalCommits: total,
					totalRestricted,
					followers: user.followers,
					following: user.following,
					publicRepos: user.publicRepos,
					bio: user.bio,
					company: user.company,
					location: user.location,
					websiteUrl: user.websiteUrl,
					twitterUsername: user.twitterUsername,
					lastFetched: now,
					// Only stamp builtAt + the per-type lifetime totals on a full rebuild. A trailing
					// refresh only re-fetches the tail, so its totals would undercount the (possibly
					// not-yet-backfilled) history — leaving them untouched keeps null = "not backfilled".
					...(fullRebuild
						? {
								builtAt: now,
								totalIssues,
								totalPullRequests,
								totalReviews,
								totalRepos,
							}
						: {}),
				},
			});

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
	} catch {
		// Persisting is best-effort: a write failure shouldn't break the response.
	}
}

async function recordLookup(database: DB, id: string, now: Date) {
	try {
		await database.insert(lookups).values({ entityId: id, searchedAt: now });
	} catch {
		/* best-effort */
	}
}

// ── In-memory fallback (no DATABASE_URL) ─────────────────────────────────────

interface MemEntry {
	history: CommitHistory;
	fetchedAt: number;
	builtAt: number;
}
const mem = new Map<string, MemEntry>();

async function getFromMemory(
	login: string,
	token: string,
	now: Date,
): Promise<CommitHistory> {
	const key = login.trim().toLowerCase();
	const cached = mem.get(key);
	const nowMs = now.getTime();

	if (!cached || nowMs - cached.builtAt > FULL_TTL) {
		const history = await fetchCommitHistory(login, token);
		mem.set(key, { history, fetchedAt: nowMs, builtAt: nowMs });
		return history;
	}
	if (nowMs - cached.fetchedAt < TAIL_TTL) return cached.history;

	const lastLabel = cached.history.points.at(-1)?.date;
	const tailStart = lastLabel
		? new Date(`${lastLabel}T00:00:00Z`)
		: new Date(cached.history.user.createdAt);
	const tailWindows = monthlyWindows(tailStart, now);

	try {
		const tailCommits = await fetchMonthlyCommits(login, token, tailWindows);
		let profile = cached.history.user;
		try {
			profile = await fetchProfile(login, token);
		} catch {
			/* keep */
		}
		const history = applyTail(
			cached.history.points,
			profile,
			tailWindows,
			tailCommits,
		);
		mem.set(key, { history, fetchedAt: nowMs, builtAt: cached.builtAt });
		return history;
	} catch {
		return cached.history;
	}
}
