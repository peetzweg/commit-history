import { sql } from "drizzle-orm";
import { type DB, db } from "#/lib/db";
import { lookups } from "#/lib/db/schema";
import {
	type CommitHistory,
	type CommitPoint,
	fetchCommitHistory,
	fetchMonthlyCommits,
	fetchProfile,
	GitHubError,
	type MonthlyCount,
	monthlyWindows,
	type Profile,
	sumContributionTypes,
} from "#/lib/github";
import { runProfileIngestion } from "#/lib/profile-ingestion";

/**
 * Incremental commit-history cache.
 *
 * Completed past months are treated as immutable: once a month is proven complete it is never
 * re-fetched. There are no periodic full rebuilds —
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
 * Storage is Postgres when DATABASE_URL is set (durable + shared across instances),
 * else a per-process in-memory Map (so local dev / the app still work with no database).
 */
const TAIL_TTL = 60_000; // serve cached untouched for 1 min — no GitHub call at all

// Wall-clock budget for starting new chunks within one request. Netlify sync functions are
// killed at ~10s; a chunk takes ~5s, so past this point we stop starting chunks and let the
// next request resume from the persisted frontier rather than get killed mid-flight.
const BUILD_BUDGET_MS = 6_000;

export async function getCommitHistory(
	login: string,
	token: string,
	opts: { now?: Date; record?: boolean } = {},
): Promise<CommitHistory> {
	// `record: false` serves the data without writing a lookups row. Embed renders use it:
	// they're third-party image fetches (GitHub camo, CDN cache misses), not someone searching,
	// and including them would pollute the small "recently looked up" list.
	const { now = new Date(), record = true } = opts;
	if (!token) {
		// Defer to the uncached path so it throws the canonical "missing token" error.
		return fetchCommitHistory(login, token);
	}
	return db
		? getFromDb(db, login, token, now, record)
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

async function getFromDb(
	database: DB,
	login: string,
	token: string,
	now: Date,
	record: boolean,
): Promise<CommitHistory> {
	const result = await runProfileIngestion(
		{ login },
		{ token, now, maxRuntimeMs: BUILD_BUDGET_MS },
	);
	if (result.status === "complete") {
		if (record) await recordLookup(database, result.entityId, now);
		return result.history;
	}
	if (result.status === "paused") {
		throw new GitHubError(
			`Still building ${result.login}'s history (large account) — try again in a few seconds to continue.`,
			503,
			result.progress,
		);
	}
	if (result.status === "unreachable") {
		if (result.history && result.entityId) {
			if (record) await recordLookup(database, result.entityId, now);
			return result.history;
		}
		throw new GitHubError(`User "${result.login}" not found.`, 404);
	}
	throw new GitHubError(
		`GitHub quota is reserved until ${result.retryAt.toISOString()}.`,
		429,
	);
}

/** Enough history for the UI with room for the 16-row display to turn over naturally. */
const RECENT_LOOKUP_RETENTION = 64;

export async function recordLookup(database: DB, id: string, now: Date) {
	try {
		await database.transaction(async (tx) => {
			// The row cap is a global invariant. Without serialization, concurrent inserts can each
			// prune the same previously-visible row and leave the table above the retention limit.
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext('commit-history'), hashtext('recent-lookups'))`,
			);
			// One row per entity: revisiting a profile moves it to the front rather than storing an
			// unbounded stream of events that the homepage would have to aggregate on every request.
			await tx
				.insert(lookups)
				.values({ entityId: id, searchedAt: now })
				.onConflictDoUpdate({
					target: lookups.entityId,
					// `now` is captured at request start. A slower older request can finish after a newer
					// one, so only move recency forward.
					set: {
						// Use the insert value so Drizzle applies the timestamp column's encoder in VALUES;
						// interpolating `now` again inside raw SQL leaves postgres.js an untyped Date.
						searchedAt: sql`greatest(${lookups.searchedAt}, excluded.searched_at)`,
					},
				});
			await tx.execute(sql`
				delete from ${lookups}
				where ${lookups.id} in (
					select ${lookups.id}
					from ${lookups}
					order by ${lookups.searchedAt} desc, ${lookups.id} desc
					offset ${RECENT_LOOKUP_RETENTION}
				)
			`);
		});
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

	// Once stale, resolve the mutable login before reading or extending its cached history.
	// A recycled login starts a new cache entry instead of combining two GitHub identities.
	const profile = await fetchProfile(login, token);
	if (profile.nodeId !== cached.history.user.nodeId) {
		const history = await fetchCommitHistory(profile.login, token);
		mem.set(key, { history, fetchedAt: nowMs });
		return history;
	}

	const lastLabel = cached.history.points.at(-1)?.date;
	const tailStart = lastLabel
		? new Date(`${lastLabel}T00:00:00Z`)
		: new Date(cached.history.user.createdAt);
	const tailWindows = monthlyWindows(tailStart, now);

	try {
		const tailCounts = await fetchMonthlyCommits(login, token, tailWindows);
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
