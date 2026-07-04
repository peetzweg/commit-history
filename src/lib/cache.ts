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
	GitHubError,
	type MonthlyCount,
	type MonthWindow,
	monthlyWindows,
	type Profile,
	sumContributionTypes,
} from "#/lib/github";

/**
 * Incremental commit-history cache.
 *
 * Completed past months are treated as immutable: once a month is stored it is never
 * re-fetched (except the frontier month, see below). There are no periodic full rebuilds —
 * a profile is built exactly once, month by month, and afterwards only extended forward.
 *
 * Builds are **resumable**: months are fetched in chunks and each chunk is persisted the
 * moment it lands, so a serverless timeout mid-build loses at most one chunk. The next
 * request picks up from the last stored month instead of starting over — large accounts
 * converge across a few requests instead of never finishing (and burning GitHub quota on
 * every doomed attempt).
 *
 * `entities.builtAt` marks a *completed* initial build (null = still building). Entity
 * totals are stamped only once every month row is stored, so a half-written build can never
 * masquerade as a finished one (zeroed charts / corrupted leaderboard totals).
 *
 * Storage is Neon Postgres when DATABASE_URL is set (durable + shared across instances),
 * else a per-process in-memory Map (so local dev / the app still work with no database).
 */
const TAIL_TTL = 60_000; // serve cached untouched for 1 min — no GitHub call at all

// Months fetched + persisted per resumable step: 3 batches × 6 months (see BATCH/CONCURRENCY
// in github.ts) = one full concurrency wave, ~5s of wall clock.
const CHUNK_MONTHS = 18;

// Wall-clock budget for starting new chunks within one request. Netlify sync functions are
// killed at ~10s; a chunk takes ~5s, so past this point we stop starting chunks and let the
// next request resume from the persisted frontier rather than get killed mid-flight.
const BUILD_BUDGET_MS = 6_000;

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

/** Assemble a CommitHistory from a profile + cumulative points. */
function toHistory(user: Profile, points: CommitPoint[]): CommitHistory {
	const last = points.at(-1);
	return {
		user,
		points,
		total: last?.cumulative ?? 0,
		totalRestricted: last?.restrictedCumulative ?? 0,
		...sumContributionTypes(points),
	};
}

/**
 * Splice freshly fetched months onto a series, replacing any overlap (the frontier month is
 * deliberately re-fetched on resume/refresh) and continuing the cumulative sums.
 */
function appendTail(
	prev: CommitPoint[],
	windows: { label: string }[],
	counts: MonthlyCount[],
): CommitPoint[] {
	const keys = new Set(windows.map((w) => w.label));
	const head = prev.filter((p) => !keys.has(p.date));
	let cumulative = head.at(-1)?.cumulative ?? 0;
	let restrictedCumulative = head.at(-1)?.restrictedCumulative ?? 0;
	const tail: CommitPoint[] = windows.map((w, i) => {
		const m = counts[i];
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
	return [...head, ...tail];
}

// ── Neon-backed store ────────────────────────────────────────────────────────

function entityId(login: string) {
	return `user:${login.trim().toLowerCase()}`;
}

type EntityRow = typeof entities.$inferSelect;

const EMPTY_MONTH: MonthlyCount = {
	commits: 0,
	restricted: 0,
	issues: 0,
	pullRequests: 0,
	reviews: 0,
	repos: 0,
};

function profileFromRow(row: EntityRow, now: Date): Profile {
	return {
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
}

async function getFromDb(
	database: DB,
	login: string,
	token: string,
	now: Date,
): Promise<CommitHistory> {
	const id = entityId(login);
	const nowMs = now.getTime();

	let row: EntityRow | undefined;
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

	let profile: Profile;
	if (row) {
		profile = profileFromRow(row, now);
	} else {
		// First sighting: the profile fetch validates the login and yields createdAt, which
		// defines the window range. Insert the row up front — it's the FK target for the month
		// rows and the resume anchor if this build doesn't finish within the request.
		profile = await fetchProfile(login, token);
		try {
			await upsertProfile(database, id, profile);
		} catch {
			// Can't store anything without the entity row (FK) — degrade to a direct fetch.
			return fetchCommitHistory(login, token);
		}
	}

	// Stored months = the immutable head of the series.
	let monthRows: { month: string; counts: MonthlyCount }[] = [];
	if (row) {
		const rows = await database
			.select()
			.from(monthlyCommits)
			.where(eq(monthlyCommits.entityId, id));
		monthRows = rows.map((r) => ({
			month: r.month,
			counts: {
				commits: r.commits,
				restricted: r.restricted,
				issues: r.issues,
				pullRequests: r.pullRequests,
				reviews: r.reviews,
				repos: r.repos,
			},
		}));
	}
	const byMonth = new Map(monthRows.map((r) => [r.month, r.counts]));
	// Labels are YYYY-MM-DD, so string order = time order.
	const lastStored = monthRows.reduce<string | null>(
		(max, r) => (max === null || r.month > max ? r.month : max),
		null,
	);

	const createdAt = row?.createdAt ?? new Date(profile.createdAt);
	const windows = monthlyWindows(createdAt, now);
	const headWindows = lastStored
		? windows.filter((w) => w.label <= lastStored)
		: [];
	// Everything from the last stored month (inclusive) forward. Re-fetching the frontier
	// month costs nothing extra and self-heals a legacy partial value in it.
	const todo = lastStored
		? windows.filter((w) => w.label >= lastStored)
		: windows;
	const head = buildPoints(
		headWindows,
		headWindows.map((w) => byMonth.get(w.label) ?? EMPTY_MONTH),
	);

	// A row only carries builtAt once its initial build completed; until then every request
	// resumes the build regardless of TTLs.
	const complete = row?.builtAt != null;

	// Fully built + fresh → serve straight from the DB, no GitHub calls at all.
	if (
		complete &&
		row?.lastFetched &&
		nowMs - row.lastFetched.getTime() < TAIL_TTL
	) {
		await recordLookup(database, id, now);
		return toHistory(profile, head);
	}

	// Refresh the mutable profile metadata (followers, bio, …) — one cheap request. Skipped
	// on first sighting, where the profile was fetched moments ago.
	if (row) {
		try {
			profile = await fetchProfile(login, token);
		} catch {
			/* keep the stored profile */
		}
	}

	// Fetch the outstanding months in resumable chunks, persisting each as soon as it lands.
	let points = head;
	let frontierDone = true;
	const startedAt = Date.now();
	try {
		for (let i = 0; i < todo.length; i += CHUNK_MONTHS) {
			if (i > 0 && Date.now() - startedAt > BUILD_BUDGET_MS) {
				frontierDone = false;
				break;
			}
			const chunk = todo.slice(i, i + CHUNK_MONTHS);
			const counts = await fetchMonthlyCommits(login, token, chunk);
			await persistMonths(database, id, chunk, counts);
			points = appendTail(points, chunk, counts);
		}
	} catch (err) {
		// Mid-build failure on an unfinished profile: everything fetched so far is persisted,
		// so surface the error and let the retry resume from the frontier.
		if (!complete) throw err;
		// Tail-refresh hiccup on an already-built profile: serve what we have.
		await recordLookup(database, id, now);
		return toHistory(profile, head);
	}

	const history = toHistory(profile, points);
	if (frontierDone) {
		// Every month is stored — only now stamp entity totals (+ builtAt on first completion).
		await persistEntity(database, id, history, now, !complete);
	} else if (!complete) {
		// Ran out of request budget mid-build. Progress is persisted; the next request resumes.
		// An honest retry beats silently serving a truncated chart with wrong totals. The progress
		// payload lets the client show a live "X of Y months" bar while it polls to continue.
		throw new GitHubError(
			`Still building ${profile.login}'s history (large account) — try again in a few seconds to continue.`,
			503,
			{ monthsFetched: points.length, monthsTotal: windows.length },
		);
	}
	await recordLookup(database, id, now);
	return history;
}

/** Insert/refresh the profile columns only — never touches totals or builtAt. */
async function upsertProfile(database: DB, id: string, user: Profile) {
	const profileCols = {
		name: user.name,
		avatarUrl: user.avatarUrl,
		followers: user.followers,
		following: user.following,
		publicRepos: user.publicRepos,
		bio: user.bio,
		company: user.company,
		location: user.location,
		websiteUrl: user.websiteUrl,
		twitterUsername: user.twitterUsername,
	};
	await database
		.insert(entities)
		.values({
			id,
			kind: "user",
			login: user.login,
			htmlUrl: `https://github.com/${user.login}`,
			createdAt: new Date(user.createdAt),
			...profileCols,
		})
		.onConflictDoUpdate({ target: entities.id, set: profileCols });
}

/**
 * Upsert one chunk of month rows. Throws on failure — the caller must not treat the chunk
 * as stored (the resume frontier is derived from these rows).
 */
async function persistMonths(
	database: DB,
	id: string,
	windows: MonthWindow[],
	counts: MonthlyCount[],
) {
	if (windows.length === 0) return;
	await database
		.insert(monthlyCommits)
		.values(
			windows.map((w, i) => ({
				entityId: id,
				month: w.label,
				commits: counts[i]?.commits ?? 0,
				restricted: counts[i]?.restricted ?? 0,
				issues: counts[i]?.issues ?? 0,
				pullRequests: counts[i]?.pullRequests ?? 0,
				reviews: counts[i]?.reviews ?? 0,
				repos: counts[i]?.repos ?? 0,
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

/**
 * Stamp the entity with the series' totals. Runs only after every month row is stored.
 * `firstCompletion` additionally stamps builtAt + the per-type lifetime totals: on a fresh
 * build every month was just fetched, so the sums are real. On a routine tail refresh the
 * type totals are left untouched — legacy rows may predate the per-type backfill (their
 * stored months default to 0), and summing those would undercount; null must keep meaning
 * "not backfilled".
 */
async function persistEntity(
	database: DB,
	id: string,
	history: CommitHistory,
	now: Date,
	firstCompletion: boolean,
) {
	const {
		user,
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
					...(firstCompletion
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
	} catch {
		// Best-effort: the month rows are already stored, and without builtAt/lastFetched the
		// next request simply re-runs this (idempotent) stamp.
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

	// Built once, then only ever extended forward — same policy as the DB store. Local dev has
	// no serverless timeout, so the initial build runs in one go.
	if (!cached) {
		const history = await fetchCommitHistory(login, token);
		mem.set(key, { history, fetchedAt: nowMs });
		return history;
	}
	if (nowMs - cached.fetchedAt < TAIL_TTL) return cached.history;

	const lastLabel = cached.history.points.at(-1)?.date;
	const tailStart = lastLabel
		? new Date(`${lastLabel}T00:00:00Z`)
		: new Date(cached.history.user.createdAt);
	const tailWindows = monthlyWindows(tailStart, now);

	try {
		const tailCounts = await fetchMonthlyCommits(login, token, tailWindows);
		let profile = cached.history.user;
		try {
			profile = await fetchProfile(login, token);
		} catch {
			/* keep */
		}
		const history = toHistory(
			profile,
			appendTail(cached.history.points, tailWindows, tailCounts),
		);
		mem.set(key, { history, fetchedAt: nowMs });
		return history;
	} catch {
		return cached.history;
	}
}
