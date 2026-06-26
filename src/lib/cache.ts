import {
	type CommitHistory,
	type CommitPoint,
	fetchCommitHistory,
	fetchMonthlyCommits,
	fetchProfile,
	monthlyWindows,
} from "#/lib/github";

/**
 * In-memory, incremental commit-history cache.
 *
 * Completed past months never change, so a returning user only needs the trailing month(s)
 * re-fetched — turning a ~`months/12`-request lifetime fetch into a single small request.
 *
 * Two TTLs:
 *  - TAIL_TTL: how long a cached result is served untouched (no GitHub call at all).
 *  - FULL_TTL: after this, rebuild from scratch — catches *backfilled* history (rebases,
 *    repos made public, email/identity changes) that can alter long-past months.
 *
 * This Map resets on server restart and is per-instance. The production swap is a shared store
 * (KV / Redis / SQLite) behind the same two functions — see README scaling path.
 */
const TAIL_TTL = 60_000; // 1 min: collapse rapid reloads into one cache hit
const FULL_TTL = 7 * 24 * 60 * 60_000; // 7 days: periodic full rebuild

interface Entry {
	history: CommitHistory;
	fetchedAt: number;
	builtAt: number; // when a full rebuild last happened
}

const store = new Map<string, Entry>();

export async function getCommitHistory(
	login: string,
	token: string,
	now = new Date(),
): Promise<CommitHistory> {
	if (!token) {
		// Defer to the uncached path so it throws the canonical "missing token" error.
		return fetchCommitHistory(login, token);
	}

	const key = login.trim().toLowerCase();
	const cached = store.get(key);
	const nowMs = now.getTime();

	// Stale → rebuild fully (also the cold-start path).
	if (!cached || nowMs - cached.builtAt > FULL_TTL) {
		const history = await fetchCommitHistory(login, token);
		store.set(key, { history, fetchedAt: nowMs, builtAt: nowMs });
		return history;
	}

	// Fresh enough → serve untouched.
	if (nowMs - cached.fetchedAt < TAIL_TTL) return cached.history;

	// Otherwise refresh only the trailing months (last cached month → now). New months get
	// appended; the current month's count is updated in place.
	const { user, points } = cached.history;
	const lastLabel = points.at(-1)?.date;
	const tailStart = lastLabel
		? new Date(`${lastLabel}T00:00:00Z`)
		: new Date(user.createdAt);
	const tailWindows = monthlyWindows(tailStart, now);

	let tailCommits: number[];
	let profile = user;
	try {
		tailCommits = await fetchMonthlyCommits(user.login, token, tailWindows);
	} catch {
		// Network hiccup on refresh: serve what we have rather than erroring the page.
		return cached.history;
	}

	// Avatar/name can change; refresh the profile opportunistically but don't fail on it.
	try {
		profile = await fetchProfile(user.login, token);
	} catch {
		/* keep cached profile */
	}

	// Merge: keep all months strictly before the tail, then recompute the tail's cumulative
	// continuing from the running total just before it.
	const tailKeys = new Set(tailWindows.map((w) => w.label));
	const head = points.filter((p) => !tailKeys.has(p.date));
	const baseCumulative = head.at(-1)?.cumulative ?? 0;

	let cumulative = baseCumulative;
	const tail: CommitPoint[] = tailWindows.map((w, i) => {
		const commits = tailCommits[i] ?? 0;
		cumulative += commits;
		return { date: w.label, commits, cumulative };
	});

	const merged = [...head, ...tail];
	const history: CommitHistory = {
		user: profile,
		points: merged,
		total: merged.at(-1)?.cumulative ?? 0,
	};
	store.set(key, { history, fetchedAt: nowMs, builtAt: cached.builtAt });
	return history;
}
