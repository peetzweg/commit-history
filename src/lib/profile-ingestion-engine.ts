import {
	buildPoints,
	type CommitHistory,
	GitHubError,
	type MonthlyCount,
	type MonthWindow,
	monthlyWindows,
	type Profile,
	type RateLimitBudget,
	sumContributionTypes,
} from "#/lib/github";

export interface ProfileIngestionTarget {
	login: string;
	/** Present for delayed work, where the immutable identity must survive a login rename. */
	githubNodeId?: string;
}

export interface RunProfileIngestionOptions {
	token: string;
	now?: Date;
	/** Allows a long-running worker to stop safely between durable chunks. */
	signal?: AbortSignal;
	/** Stop before starting another chunk once this much wall time has elapsed. */
	maxRuntimeMs?: number;
	/** When set, preserve this many GitHub GraphQL points for live traffic. */
	remainingFloor?: number;
}

export type ProfileIngestionResult =
	| {
			status: "complete";
			entityId: string;
			login: string;
			monthsStored: number;
			history: CommitHistory;
	  }
	| {
			status: "paused";
			entityId: string;
			login: string;
			progress: { monthsFetched: number; monthsTotal: number };
	  }
	| { status: "deferred"; retryAt: Date }
	| {
			status: "unreachable";
			login: string;
			entityId?: string;
			history?: CommitHistory;
	  };

export interface StoredProfile {
	entityId: string;
	profile: Profile;
	builtAt: Date | null;
	lastFetched: Date | null;
}

export interface StoredProfileMonth {
	month: string;
	counts: MonthlyCount;
	fetchedAt: Date | null;
}

/** Internal persistence seam. Application and worker callers never need to learn it. */
export interface ProfileIngestionStore {
	findProfile(
		target: ProfileIngestionTarget,
	): Promise<StoredProfile | undefined>;
	saveProfile(profile: Profile): Promise<StoredProfile>;
	storedMonths(entityId: string): Promise<StoredProfileMonth[]>;
	saveMonths(
		entityId: string,
		months: StoredProfileMonth[],
		fetchedAt: Date,
	): Promise<void>;
	markComplete(
		entityId: string,
		history: CommitHistory,
		expectedMonths: string[],
		at: Date,
	): Promise<void>;
	markUnreachable(entityId: string, at: Date): Promise<void>;
}

/** Internal GitHub seam. The production adapter is assembled in profile-ingestion.ts. */
export interface ProfileIngestionGitHub {
	fetchProfileByLogin(login: string, token: string): Promise<Profile>;
	fetchProfileByNodeId(nodeId: string, token: string): Promise<Profile>;
	fetchMonthlyCommits(
		login: string,
		token: string,
		windows: MonthWindow[],
	): Promise<MonthlyCount[]>;
	fetchRateLimitBudget(token: string): Promise<RateLimitBudget | null>;
}

interface ProfileIngestionDependencies {
	store: ProfileIngestionStore;
	github: ProfileIngestionGitHub;
	/** Internal test seam; production deliberately keeps the GitHub concurrency wave at 18. */
	chunkMonths?: number;
	timeMs?: () => number;
	cacheTtlMs?: number;
}

const CHUNK_MONTHS = 18;
const CACHE_TTL_MS = 60_000;

/**
 * Build the profile-ingestion operation around concrete adapters. This constructor is internal
 * to the module; production callers use the single `runProfileIngestion` interface.
 */
export function createProfileIngestion(deps: ProfileIngestionDependencies) {
	const chunkMonths = positiveInteger(
		deps.chunkMonths ?? CHUNK_MONTHS,
		"chunkMonths",
	);
	const cacheTtlMs = nonNegativeNumber(
		deps.cacheTtlMs ?? CACHE_TTL_MS,
		"cacheTtlMs",
	);
	const timeMs = deps.timeMs ?? Date.now;

	return async function runProfileIngestion(
		target: ProfileIngestionTarget,
		opts: RunProfileIngestionOptions,
	): Promise<ProfileIngestionResult> {
		opts.signal?.throwIfAborted();
		const now = opts.now ?? new Date();
		const startedAt = timeMs();
		const maxRuntimeMs = nonNegativeNumber(
			opts.maxRuntimeMs ?? Number.POSITIVE_INFINITY,
			"maxRuntimeMs",
		);
		const storedTarget = await deps.store.findProfile(target);

		if (
			!target.githubNodeId &&
			storedTarget?.builtAt &&
			storedTarget.lastFetched
		) {
			const age = now.getTime() - storedTarget.lastFetched.getTime();
			if (age >= 0 && age < cacheTtlMs) {
				const cached = await completedHistory(deps.store, storedTarget, now);
				if (cached) return completeResult(storedTarget.entityId, cached);
			}
		}

		const initialDeferral = await rateLimitDeferral(
			deps.github,
			opts.token,
			opts.remainingFloor,
			1,
		);
		if (initialDeferral) return initialDeferral;
		opts.signal?.throwIfAborted();

		let profile: Profile;
		try {
			profile = target.githubNodeId
				? await deps.github.fetchProfileByNodeId(
						target.githubNodeId,
						opts.token,
					)
				: await deps.github.fetchProfileByLogin(target.login, opts.token);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) {
				if (storedTarget) {
					await deps.store.markUnreachable(storedTarget.entityId, now);
					const history = storedTarget.builtAt
						? await availableHistory(deps.store, storedTarget, now)
						: undefined;
					return {
						status: "unreachable",
						login: target.login,
						entityId: storedTarget.entityId,
						...(history ? { history } : {}),
					};
				}
				return { status: "unreachable", login: target.login };
			}
			// The request path historically serves a complete cached profile through a transient
			// metadata outage. Immutable-id jobs deliberately throw so their queue can retry.
			if (!target.githubNodeId && storedTarget?.builtAt) {
				const cached = await availableHistory(deps.store, storedTarget, now);
				return completeResult(storedTarget.entityId, cached);
			}
			throw error;
		}
		if (target.githubNodeId && profile.nodeId !== target.githubNodeId) {
			throw new Error(
				`GitHub identity mismatch for ${target.login}: expected ${target.githubNodeId}.`,
			);
		}

		// Identity resolution happens before loading any months. A recycled login can therefore
		// never make one person's contribution rows the input to another person's build.
		const stored = await deps.store.saveProfile(profile);
		const rows = await deps.store.storedMonths(stored.entityId);
		const windows = monthlyWindows(new Date(profile.createdAt), now);
		const completeRows = new Map(
			rows
				.filter((row) => isCompletedMonth(row))
				.map((row) => [row.month, row]),
		);
		const missing = windows.filter((window) => !completeRows.has(window.label));
		const wasComplete = stored.builtAt != null;

		try {
			for (let index = 0; index < missing.length; index += chunkMonths) {
				opts.signal?.throwIfAborted();
				if (index > 0 && timeMs() - startedAt > maxRuntimeMs) {
					return {
						status: "paused",
						entityId: stored.entityId,
						login: profile.login,
						progress: {
							monthsFetched: completeRows.size,
							monthsTotal: windows.length,
						},
					};
				}
				const chunk = missing.slice(index, index + chunkMonths);
				const deferral = await rateLimitDeferral(
					deps.github,
					opts.token,
					opts.remainingFloor,
					chunk.length,
				);
				if (deferral) return deferral;
				const chunkCounts = await deps.github.fetchMonthlyCommits(
					profile.login,
					opts.token,
					chunk,
				);
				if (chunkCounts.length !== chunk.length) {
					throw new Error(
						`GitHub returned ${chunkCounts.length} month counts for ${chunk.length} windows.`,
					);
				}
				const fetched = chunk.map((window, countIndex) => ({
					month: window.label,
					counts: chunkCounts[countIndex],
					fetchedAt: now,
				}));
				await deps.store.saveMonths(stored.entityId, fetched, now);
				for (const month of fetched) completeRows.set(month.month, month);
			}
		} catch (error) {
			if (opts.signal?.aborted) throw error;
			if (wasComplete) {
				const cached = historyFromAvailable(profile, windows, completeRows);
				return completeResult(stored.entityId, cached);
			}
			throw error;
		}

		const history = historyFrom(profile, windows, completeRows);
		await deps.store.markComplete(
			stored.entityId,
			history,
			windows.map((window) => window.label),
			now,
		);
		return completeResult(stored.entityId, history);
	};
}

async function availableHistory(
	store: ProfileIngestionStore,
	stored: StoredProfile,
	now: Date,
): Promise<CommitHistory> {
	const windows = monthlyWindows(new Date(stored.profile.createdAt), now);
	const rows = await store.storedMonths(stored.entityId);
	const completeRows = new Map(
		rows.filter(isCompletedMonth).map((row) => [row.month, row]),
	);
	return historyFromAvailable(stored.profile, windows, completeRows);
}

async function completedHistory(
	store: ProfileIngestionStore,
	stored: StoredProfile,
	now: Date,
): Promise<CommitHistory | undefined> {
	const windows = monthlyWindows(new Date(stored.profile.createdAt), now);
	const rows = await store.storedMonths(stored.entityId);
	const completeRows = new Map(
		rows.filter((row) => isCompletedMonth(row)).map((row) => [row.month, row]),
	);
	if (windows.some((window) => !completeRows.has(window.label)))
		return undefined;
	return historyFrom(stored.profile, windows, completeRows);
}

function historyFrom(
	profile: Profile,
	windows: MonthWindow[],
	rows: Map<string, StoredProfileMonth>,
): CommitHistory {
	const points = buildPoints(
		windows,
		windows.map((window) => {
			const row = rows.get(window.label);
			if (!row) throw new Error(`Completed month ${window.label} is missing.`);
			return row.counts;
		}),
	);
	const last = points.at(-1);
	return {
		user: profile,
		points,
		total: last?.cumulative ?? 0,
		totalRestricted: last?.restrictedCumulative ?? 0,
		...sumContributionTypes(points),
	};
}

function historyFromAvailable(
	profile: Profile,
	windows: MonthWindow[],
	rows: Map<string, StoredProfileMonth>,
): CommitHistory {
	return historyFrom(
		profile,
		windows.filter((window) => rows.has(window.label)),
		rows,
	);
}

function completeResult(
	entityId: string,
	history: CommitHistory,
): Extract<ProfileIngestionResult, { status: "complete" }> {
	return {
		status: "complete",
		entityId,
		login: history.user.login,
		monthsStored: history.points.length,
		history,
	};
}

function isCompletedMonth(row: StoredProfileMonth): boolean {
	if (!row.fetchedAt) return false;
	const start = new Date(`${row.month}T00:00:00.000Z`);
	if (Number.isNaN(start.getTime())) return false;
	const nextMonth = new Date(
		Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
	);
	return row.fetchedAt >= nextMonth;
}

async function rateLimitDeferral(
	github: ProfileIngestionGitHub,
	token: string,
	remainingFloor: number | undefined,
	requiredHeadroom: number,
): Promise<Extract<ProfileIngestionResult, { status: "deferred" }> | null> {
	if (remainingFloor == null) return null;
	const floor = nonNegativeNumber(remainingFloor, "remainingFloor");
	const budget = await github.fetchRateLimitBudget(token);
	if (!budget || budget.remaining >= floor + Math.max(1, requiredHeadroom)) {
		return null;
	}
	const retryAt = new Date(budget.resetAt);
	if (Number.isNaN(retryAt.getTime())) {
		throw new Error("GitHub returned an invalid rate-limit reset time.");
	}
	return { status: "deferred", retryAt };
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value;
}

function nonNegativeNumber(value: number, name: string): number {
	if (Number.isNaN(value) || value < 0) {
		throw new Error(`${name} must be a non-negative number.`);
	}
	return value;
}
