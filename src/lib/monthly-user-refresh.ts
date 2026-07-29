import type { MonthlyCount, MonthWindow } from "#/lib/github";

export const USER_REFRESH_METRICS = [
	"public",
	"prs",
	"issues",
	"reviews",
	"repos",
	"private",
	"total",
	"followers",
] as const;

export type UserRefreshMetric = (typeof USER_REFRESH_METRICS)[number];

export interface RefreshCandidate {
	id: string;
	login: string;
}

export interface MonthlyRefreshStore {
	tryLock(): Promise<boolean>;
	releaseLock(): Promise<void>;
	usersForMetric(
		metric: UserRefreshMetric | string,
		limit: number,
	): Promise<RefreshCandidate[]>;
	hasMonth(id: string, month: string): Promise<boolean>;
	upsertMonth(id: string, month: string, counts: MonthlyCount): Promise<void>;
	recomputeTotals(id: string, fetchedAt: Date): Promise<MonthlyCount>;
}

export interface MonthlyRefreshLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface RunMonthlyUserRefreshOptions {
	store: MonthlyRefreshStore;
	token: string;
	now?: Date;
	targetMonth?: string;
	safeAfterUtc?: string;
	metrics?: readonly (UserRefreshMetric | string)[];
	limitPerMetric?: number;
	maxUsers?: number;
	ratePerHour?: number;
	maxRuntimeMs?: number;
	dryRun?: boolean;
	allowIncompleteMonth?: boolean;
	fetchMonthlyCommits: (
		login: string,
		token: string,
		windows: MonthWindow[],
	) => Promise<MonthlyCount[]>;
	sleep?: (ms: number) => Promise<void>;
	timeMs?: () => number;
	logger?: MonthlyRefreshLogger;
}

export interface MonthlyUserRefreshResult {
	status: "completed" | "locked" | "too_early" | "stopped";
	targetMonth: string;
	candidates: number;
	skippedFresh: number;
	dryRunWouldRefresh: number;
	refreshed: number;
	failed: number;
	dryRun: boolean;
}

export function resolveTargetMonth(opts: {
	now: Date;
	safeAfterUtc: string;
}):
	| { ok: true; month: string }
	| { ok: false; reason: "too_early"; month: string; safeAt: string } {
	const safe = parseSafeAfterUtc(opts.safeAfterUtc);
	const monthStart = new Date(
		Date.UTC(opts.now.getUTCFullYear(), opts.now.getUTCMonth(), 1),
	);
	const safeAt = new Date(monthStart.getTime() + safe.minutesAfterMidnight * 60_000);
	const target = monthLabel(
		new Date(Date.UTC(opts.now.getUTCFullYear(), opts.now.getUTCMonth() - 1, 1)),
	);

	if (opts.now.getUTCDate() === 1 && opts.now.getTime() < safeAt.getTime()) {
		return {
			ok: false,
			reason: "too_early",
			month: target,
			safeAt: safeAt.toISOString(),
		};
	}
	return { ok: true, month: target };
}

export async function runMonthlyUserRefresh(
	opts: RunMonthlyUserRefreshOptions,
): Promise<MonthlyUserRefreshResult> {
	const now = opts.now ?? new Date();
	const dryRun = opts.dryRun ?? false;
	const logger = opts.logger ?? quietLogger;
	const metrics = opts.metrics ?? USER_REFRESH_METRICS;
	const limitPerMetric = positiveInteger(opts.limitPerMetric ?? 500, "limitPerMetric");
	const maxUsers =
		opts.maxUsers == null ? undefined : positiveInteger(opts.maxUsers, "maxUsers");
	const ratePerHour = positiveInteger(opts.ratePerHour ?? 1000, "ratePerHour");
	const sleep = opts.sleep ?? defaultSleep;
	const timeMs = opts.timeMs ?? Date.now;
	const startedAt = timeMs();
	const target = opts.targetMonth
		? normalizeTargetMonth(opts.targetMonth)
		: resolveTargetMonth({
				now,
				safeAfterUtc: opts.safeAfterUtc ?? "03:00",
			});

	if (typeof target !== "string" && !target.ok) {
		logger.info(
			`monthly-user-refresh startup target_month=${target.month} status=too_early safe_at=${target.safeAt}`,
		);
		return emptyResult("too_early", target.month, dryRun);
	}

	const targetMonth = typeof target === "string" ? target : target.month;
	const currentMonth = monthLabel(
		new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
	);
	if (!dryRun && !opts.allowIncompleteMonth && targetMonth >= currentMonth) {
		throw new Error(
			`Target month ${targetMonth} is not completed yet. The newest completed UTC month is before ${currentMonth}.`,
		);
	}
	const window = windowForMonth(targetMonth);
	logger.info(
		`monthly-user-refresh startup target_month=${targetMonth} utc_now=${now.toISOString()} dry_run=${dryRun} allow_incomplete_month=${opts.allowIncompleteMonth ?? false} limit_per_metric=${limitPerMetric} max_users=${maxUsers ?? "none"} rate_per_hour=${ratePerHour}`,
	);

	const locked = await opts.store.tryLock();
	if (!locked) {
		logger.warn(
			`monthly-user-refresh target_month=${targetMonth} status=locked lock=held_elsewhere`,
		);
		return emptyResult("locked", targetMonth, dryRun);
	}

	const result = emptyResult("completed", targetMonth, dryRun);
	try {
		const candidates = (
			await candidateUnion(opts.store, metrics, limitPerMetric)
		).slice(0, maxUsers);
		result.candidates = candidates.length;
		logger.info(
			`monthly-user-refresh target_month=${targetMonth} candidates=${candidates.length}`,
		);

		for (const candidate of candidates) {
			if (
				opts.maxRuntimeMs &&
				timeMs() - startedAt >= opts.maxRuntimeMs &&
				result.refreshed + result.failed + result.dryRunWouldRefresh > 0
			) {
				result.status = "stopped";
				logger.warn(
					`monthly-user-refresh target_month=${targetMonth} status=stopped reason=max_runtime`,
				);
				break;
			}

			if (await opts.store.hasMonth(candidate.id, targetMonth)) {
				result.skippedFresh += 1;
				continue;
			}

			if (dryRun) {
				result.dryRunWouldRefresh += 1;
				logger.info(
					`monthly-user-refresh target_month=${targetMonth} login=${candidate.login} status=dry_run`,
				);
				continue;
			}

			const refreshed = await refreshOne({
				candidate,
				token: opts.token,
				window,
				targetMonth,
				now,
				store: opts.store,
				fetchMonthlyCommits: opts.fetchMonthlyCommits,
				logger,
			});
			if (refreshed) result.refreshed += 1;
			else result.failed += 1;

			await sleep((1 / ratePerHour) * 3_600_000);
		}
	} finally {
		await opts.store.releaseLock();
	}

	logger.info(
		`monthly-user-refresh done target_month=${targetMonth} status=${result.status} candidates=${result.candidates} refreshed=${result.refreshed} skipped_fresh=${result.skippedFresh} failed=${result.failed} dry_run_would_refresh=${result.dryRunWouldRefresh}`,
	);
	return result;
}

async function candidateUnion(
	store: MonthlyRefreshStore,
	metrics: readonly (UserRefreshMetric | string)[],
	limit: number,
): Promise<RefreshCandidate[]> {
	const buckets: RefreshCandidate[][] = [];
	for (const metric of metrics) buckets.push(await store.usersForMetric(metric, limit));

	const byId = new Map<string, RefreshCandidate>();
	for (let index = 0; index < limit; index++) {
		for (const bucket of buckets) {
			const row = bucket[index];
			if (!row) continue;
			if (!byId.has(row.id)) byId.set(row.id, row);
		}
	}
	return [...byId.values()];
}

async function refreshOne(opts: {
	candidate: RefreshCandidate;
	token: string;
	window: MonthWindow;
	targetMonth: string;
	now: Date;
	store: MonthlyRefreshStore;
	fetchMonthlyCommits: (
		login: string,
		token: string,
		windows: MonthWindow[],
	) => Promise<MonthlyCount[]>;
	logger: MonthlyRefreshLogger;
}): Promise<boolean> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const [counts] = await opts.fetchMonthlyCommits(
				opts.candidate.login,
				opts.token,
				[opts.window],
			);
			await opts.store.upsertMonth(
				opts.candidate.id,
				opts.targetMonth,
				counts ?? zeroMonth(),
			);
			const totals = await opts.store.recomputeTotals(opts.candidate.id, opts.now);
			opts.logger.info(
				`monthly-user-refresh target_month=${opts.targetMonth} login=${opts.candidate.login} status=refreshed commits=${totals.commits} total=${totalContributions(totals)}`,
			);
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (attempt === 1) {
				opts.logger.warn(
					`monthly-user-refresh target_month=${opts.targetMonth} login=${opts.candidate.login} status=retrying error=${JSON.stringify(message)}`,
				);
				continue;
			}
			opts.logger.error(
				`monthly-user-refresh target_month=${opts.targetMonth} login=${opts.candidate.login} status=failed error=${JSON.stringify(message)}`,
			);
			return false;
		}
	}
	return false;
}

function windowForMonth(month: string): MonthWindow {
	const [year, monthNumber] = monthParts(month);
	const from = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0));
	const to = new Date(Date.UTC(year, monthNumber, 0, 23, 59, 59));
	return { from: from.toISOString(), to: to.toISOString(), label: month };
}

function normalizeTargetMonth(month: string): string {
	const [year, monthNumber] = monthParts(month);
	return `${year}-${String(monthNumber).padStart(2, "0")}-01`;
}

function monthParts(month: string): [number, number] {
	const match = /^(\d{4})-(\d{2})-01$/.exec(month);
	if (!match) throw new Error(`Invalid target month "${month}". Use YYYY-MM-01.`);
	const year = Number(match[1]);
	const monthNumber = Number(match[2]);
	if (monthNumber < 1 || monthNumber > 12) {
		throw new Error(`Invalid target month "${month}". Use YYYY-MM-01.`);
	}
	return [year, monthNumber];
}

function monthLabel(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function parseSafeAfterUtc(value: string): { minutesAfterMidnight: number } {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match) throw new Error(`Invalid safe-after UTC time "${value}". Use HH:MM.`);
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) {
		throw new Error(`Invalid safe-after UTC time "${value}". Use HH:MM.`);
	}
	return { minutesAfterMidnight: hours * 60 + minutes };
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value;
}

function totalContributions(counts: MonthlyCount): number {
	return (
		counts.commits +
		counts.restricted +
		counts.issues +
		counts.pullRequests +
		counts.reviews +
		counts.repos
	);
}

function zeroMonth(): MonthlyCount {
	return {
		commits: 0,
		restricted: 0,
		issues: 0,
		pullRequests: 0,
		reviews: 0,
		repos: 0,
	};
}

function emptyResult(
	status: MonthlyUserRefreshResult["status"],
	targetMonth: string,
	dryRun: boolean,
): MonthlyUserRefreshResult {
	return {
		status,
		targetMonth,
		candidates: 0,
		skippedFresh: 0,
		dryRunWouldRefresh: 0,
		refreshed: 0,
		failed: 0,
		dryRun,
	};
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const quietLogger: MonthlyRefreshLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};
