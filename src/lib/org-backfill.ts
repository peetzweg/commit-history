/**
 * Incremental lifetime-totals backfill for organizations the request path won't build on demand.
 *
 * After #103 an org with more than MAX_ORG_MEMBERS (25) public members is *recorded* on lookup
 * (an `entities` row with `builtAt` null) but never built live — building a mega-org on a page
 * request would burn the shared token's hourly budget. This engine drains that queue in the
 * background, a bounded slice per run, and writes the SAME numbers the request path produces for
 * small orgs: each public member's lifetime contributions *to that org*, summed onto the org row.
 *
 * Only existing tables are written (`org_members` rows + the `entities` roll-up), so no migration.
 *
 * Designed to be run daily and to *not finish*:
 *   - every write is an idempotent upsert,
 *   - a member's `last_fetched` marks it done, so a re-run resumes instead of restarting,
 *   - `builtAt` is stamped only once every enumerated member is fetched, so a partially-filled org
 *     stays in the queue and is picked up again tomorrow,
 *   - per-run caps (requests, wall clock) stop the run cleanly rather than being killed.
 *
 * Smallest org first: a 2,800-member org is ~10,000 GraphQL points, several nights' worth of
 * budget on its own. Ordering by member count keeps it from blocking every small org behind it,
 * and re-reading the queue each run lets a newly-recorded small org jump ahead of it.
 */
import {
	GitHubError,
	type MonthWindow,
	type OrgMember,
	type OrgMemberTotals,
	type OrgProfile,
	type RateLimitBudget,
} from "#/lib/github";
import {
	type BudgetGuard,
	createBudgetGuard,
	defaultSleep,
	type JobLogger,
	nonNegativeInteger,
	positiveInteger,
	quietLogger,
} from "#/lib/job-runner";

export const orgEntityId = (login: string) =>
	`org:${login.trim().toLowerCase()}`;
export const userEntityId = (login: string) =>
	`user:${login.trim().toLowerCase()}`;

/**
 * `fetchOrgMemberContributions` batches this many yearly windows into one GraphQL request. Used
 * only to price a member (pacing + the per-run request cap), never for correctness: over-estimating
 * just spends the budget more conservatively.
 */
const WINDOWS_PER_REQUEST = 6;

/**
 * Give up on the whole run after this many orgs fail back to back without a single member fetched.
 * A systemic fault (bad token, missing read:org, exhausted quota, GitHub outage) fails every org
 * identically and in seconds; the old script logged each one and still printed "Done", which reads
 * exactly like success. Failing loudly is the point.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface OrgBackfillTarget {
	login: string;
	/** Null for orgs named on the command line — the profile fetch records them. */
	id: string | null;
	memberCount: number | null;
	source: "unfilled" | "stale" | "explicit";
}

export interface OrgBackfillStore {
	tryLock(): Promise<boolean>;
	releaseLock(): Promise<void>;
	/** Recorded but never built (`builtAt` null), fewest members first. */
	unfilledOrgs(limit: number): Promise<OrgBackfillTarget[]>;
	/** Built before `builtBefore`, oldest first — the staleness rotation. */
	staleOrgs(builtBefore: Date, limit: number): Promise<OrgBackfillTarget[]>;
	/** Queue depth, for the summary line. */
	countUnfilled(): Promise<number>;
	/** Upsert the profile columns (never stamps `builtAt`); returns the org's entity id. */
	upsertOrgProfile(profile: OrgProfile, fetchedAt: Date): Promise<string>;
	/** User stubs + pending `org_members` rows. Idempotent; never overwrites a real user row. */
	recordMembers(orgId: string, members: OrgMember[]): Promise<void>;
	/** Member entity ids with a `last_fetched` — done in this run or an earlier one. */
	fetchedMemberIds(orgId: string): Promise<Set<string>>;
	saveMemberTotals(
		orgId: string,
		memberId: string,
		totals: OrgMemberTotals,
		fetchedAt: Date,
	): Promise<void>;
	/** Sum `org_members` onto the org row and stamp `builtAt`. */
	rollUpOrg(orgId: string, fetchedAt: Date): Promise<OrgMemberTotals>;
}

export interface RunOrgBackfillOptions {
	store: OrgBackfillStore;
	token: string;
	now?: Date;
	/** Orgs named explicitly; bypasses the queue (and records them if new). */
	logins?: string[];
	/** How many queued orgs to consider in one run. */
	maxOrgs?: number;
	/** Per-run GraphQL request budget — the "reasonable amount" a nightly run may spend. */
	maxRequests?: number;
	/** Re-fill built orgs older than this. 0 disables the staleness phase. */
	staleAfterDays?: number;
	/** How many stale orgs per run. Only reached when the unfilled queue is empty. */
	maxStaleOrgs?: number;
	ratePerHour?: number;
	maxRuntimeMs?: number;
	/** Never spend the token's budget below this — headroom for live site traffic. */
	remainingFloor?: number;
	/** Requests between budget polls. The poll itself costs 0 points. */
	pollEvery?: number;
	/** Member pagination cap (pages of 100). Higher than the request path's on purpose. */
	memberPages?: number;
	/** Re-fetch members that are already filled, instead of resuming past them. */
	force?: boolean;
	dryRun?: boolean;
	fetchRateLimit?: () => Promise<RateLimitBudget | null>;
	fetchOrgProfile: (login: string, token: string) => Promise<OrgProfile>;
	fetchOrgMembers: (
		login: string,
		token: string,
		opts?: { maxPages?: number },
	) => Promise<{ members: OrgMember[]; truncated: boolean }>;
	fetchOrgMemberContributions: (
		login: string,
		orgNodeId: string,
		token: string,
		windows: MonthWindow[],
	) => Promise<OrgMemberTotals>;
	yearlyWindows: (start: Date, now: Date) => MonthWindow[];
	sleep?: (ms: number) => Promise<void>;
	timeMs?: () => number;
	logger?: JobLogger;
}

export interface OrgBackfillResult {
	status: "completed" | "locked" | "stopped";
	stopReason?:
		| "max_runtime"
		| "max_requests"
		| "rate_limit_floor"
		| "consecutive_failures";
	orgsAttempted: number;
	/** Finished this run — every enumerated member fetched, `builtAt` stamped. */
	orgsFilled: number;
	/** Progressed but ran out of budget/time; still queued for the next run. */
	orgsPartial: number;
	orgsFailed: number;
	membersFetched: number;
	/** Already had totals from an earlier run (resume). */
	membersSkipped: number;
	/** Gone from GitHub (404/400); stored as zeros so they can't wedge the queue. */
	membersFailed: number;
	membersWouldFetch: number;
	requestsSpent: number;
	/** Orgs still unfilled after this run, or null if the count itself failed. */
	queueRemaining: number | null;
	dryRun: boolean;
}

/** Thrown to unwind out of a member loop when the run as a whole must stop. */
class StopRun extends Error {
	constructor(readonly reason: NonNullable<OrgBackfillResult["stopReason"]>) {
		super(`stop:${reason}`);
	}
}

export async function runOrgBackfill(
	opts: RunOrgBackfillOptions,
): Promise<OrgBackfillResult> {
	const now = opts.now ?? new Date();
	const dryRun = opts.dryRun ?? false;
	const force = opts.force ?? false;
	const logger = opts.logger ?? quietLogger;
	const maxOrgs = positiveInteger(opts.maxOrgs ?? 25, "maxOrgs");
	const maxRequests = positiveInteger(opts.maxRequests ?? 1500, "maxRequests");
	const ratePerHour = positiveInteger(opts.ratePerHour ?? 1200, "ratePerHour");
	const remainingFloor = positiveInteger(
		opts.remainingFloor ?? 500,
		"remainingFloor",
	);
	const pollEvery = positiveInteger(opts.pollEvery ?? 25, "pollEvery");
	const memberPages = positiveInteger(opts.memberPages ?? 30, "memberPages");
	const staleAfterDays = nonNegativeInteger(
		opts.staleAfterDays ?? 0,
		"staleAfterDays",
	);
	const maxStaleOrgs = nonNegativeInteger(
		opts.maxStaleOrgs ?? 0,
		"maxStaleOrgs",
	);
	const sleep = opts.sleep ?? defaultSleep;
	const timeMs = opts.timeMs ?? Date.now;
	const startedAt = timeMs();
	const runtimeLeftMs = () =>
		opts.maxRuntimeMs ? opts.maxRuntimeMs - (timeMs() - startedAt) : Infinity;

	logger.info(
		`org-backfill startup utc_now=${now.toISOString()} dry_run=${dryRun} force=${force} max_orgs=${maxOrgs} max_requests=${maxRequests} rate_per_hour=${ratePerHour} remaining_floor=${opts.fetchRateLimit ? remainingFloor : "unenforced"} poll_every=${pollEvery} member_pages=${memberPages} stale_after_days=${staleAfterDays || "off"} max_stale_orgs=${maxStaleOrgs || "off"} max_runtime_minutes=${opts.maxRuntimeMs ? Math.round(opts.maxRuntimeMs / 60_000) : "none"}`,
	);

	const result = emptyResult(dryRun);

	const locked = await opts.store.tryLock();
	if (!locked) {
		logger.warn("org-backfill status=locked lock=held_elsewhere");
		result.status = "locked";
		return result;
	}

	const budget = createBudgetGuard({
		label: "org-backfill",
		remainingFloor,
		pollEvery,
		fetchRateLimit: opts.fetchRateLimit,
		sleep,
		nowMs: timeMs,
		runtimeLeftMs,
		logger,
	});

	try {
		const targets = await resolveTargets({
			store: opts.store,
			logins: opts.logins,
			maxOrgs,
			staleAfterDays,
			maxStaleOrgs,
			now,
			logger,
		});

		let consecutiveFailures = 0;
		for (const target of targets) {
			// Budget/clock gates live here as well as inside the member loop so a run that is
			// already spent doesn't pay a profile + enumeration fetch just to stop immediately.
			const gate = checkGates({
				budget,
				maxRequests,
				runtimeLeftMs,
				progressed: hasProgress(result),
			});
			if (gate) {
				stop(result, gate, logger);
				break;
			}

			result.orgsAttempted += 1;
			try {
				await fillOrg({
					target,
					// A stale re-fill has to re-fetch members that already have totals; that IS the
					// refresh. Queue fills resume past them.
					force: force || target.source === "stale",
					now,
					dryRun,
					memberPages,
					maxRequests,
					ratePerHour,
					budget,
					runtimeLeftMs,
					sleep,
					logger,
					result,
					opts,
				});
				consecutiveFailures = 0;
			} catch (err) {
				if (err instanceof StopRun) {
					stop(result, err.reason, logger);
					break;
				}
				result.orgsFailed += 1;
				consecutiveFailures += 1;
				const status = err instanceof GitHubError ? err.status : undefined;
				logger.error(
					`org-backfill login=${target.login} status=failed${status ? ` http=${status}` : ""} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
				);
				if (
					consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
					result.membersFetched === 0
				) {
					stop(result, "consecutive_failures", logger);
					break;
				}
			}
		}
	} finally {
		result.requestsSpent = budget.spent();
		// Release the lock BEFORE anything else, and never let cleanup throw. A query that fails in
		// here (a blipped connection is enough) would otherwise skip `pg_advisory_unlock`, and the
		// lock lives on in a server-side session that outlives the crashed process — so every later
		// run reports status=locked and quietly does nothing. Silent and self-perpetuating.
		try {
			await opts.store.releaseLock();
		} catch (err) {
			logger.error(
				`org-backfill status=lock_release_failed error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
			);
		}
		// Queue depth is reporting only, so it must not be able to sink the run.
		try {
			result.queueRemaining = await opts.store.countUnfilled();
		} catch {
			result.queueRemaining = null;
		}
	}

	logger.info(
		`org-backfill done status=${result.status}${result.stopReason ? ` reason=${result.stopReason}` : ""} orgs_attempted=${result.orgsAttempted} orgs_filled=${result.orgsFilled} orgs_partial=${result.orgsPartial} orgs_failed=${result.orgsFailed} members_fetched=${result.membersFetched} members_skipped=${result.membersSkipped} members_failed=${result.membersFailed}${dryRun ? ` members_would_fetch=${result.membersWouldFetch}` : ""} requests_spent=${result.requestsSpent} queue_remaining=${result.queueRemaining ?? "unknown"} dry_run=${dryRun}`,
	);
	return result;
}

/**
 * Queue fills always win: the staleness rotation is only consulted once nothing is unfilled, so
 * refreshing old numbers can never starve an org that has none at all.
 */
async function resolveTargets(opts: {
	store: OrgBackfillStore;
	logins?: string[];
	maxOrgs: number;
	staleAfterDays: number;
	maxStaleOrgs: number;
	now: Date;
	logger: JobLogger;
}): Promise<OrgBackfillTarget[]> {
	if (opts.logins?.length) {
		opts.logger.info(
			`org-backfill phase=explicit orgs=${opts.logins.length} logins=${opts.logins.join(",")}`,
		);
		return opts.logins.map((login) => ({
			login,
			id: null,
			memberCount: null,
			source: "explicit" as const,
		}));
	}

	const unfilled = await opts.store.unfilledOrgs(opts.maxOrgs);
	if (unfilled.length > 0) {
		opts.logger.info(
			`org-backfill phase=unfilled orgs=${unfilled.length} logins=${unfilled.map((o) => o.login).join(",")}`,
		);
		return unfilled;
	}

	if (opts.staleAfterDays === 0 || opts.maxStaleOrgs === 0) {
		opts.logger.info("org-backfill phase=unfilled orgs=0 stale=off");
		return [];
	}

	const builtBefore = new Date(
		opts.now.getTime() - opts.staleAfterDays * 86_400_000,
	);
	const stale = await opts.store.staleOrgs(builtBefore, opts.maxStaleOrgs);
	opts.logger.info(
		`org-backfill phase=stale built_before=${builtBefore.toISOString()} orgs=${stale.length}${stale.length ? ` logins=${stale.map((o) => o.login).join(",")}` : ""}`,
	);
	return stale;
}

async function fillOrg(ctx: {
	target: OrgBackfillTarget;
	force: boolean;
	now: Date;
	dryRun: boolean;
	memberPages: number;
	maxRequests: number;
	ratePerHour: number;
	budget: BudgetGuard;
	runtimeLeftMs: () => number;
	sleep: (ms: number) => Promise<void>;
	logger: JobLogger;
	result: OrgBackfillResult;
	opts: RunOrgBackfillOptions;
}): Promise<void> {
	const { target, logger, result, opts, budget, dryRun } = ctx;
	const login = target.login;

	// Profile first: validates the login, yields nodeId (keys every org-scoped contribution query)
	// and createdAt (bounds each member's windows). Also records an org nobody has looked up yet.
	if (!(await budget.ensure())) throw new StopRun("rate_limit_floor");
	const profile = await opts.fetchOrgProfile(login, opts.token);
	budget.spend(1);
	const orgId = dryRun
		? (target.id ?? orgEntityId(profile.login))
		: await opts.store.upsertOrgProfile(profile, ctx.now);
	const orgCreated = new Date(profile.createdAt);

	if (!(await budget.ensure())) throw new StopRun("rate_limit_floor");
	const { members, truncated } = await opts.fetchOrgMembers(login, opts.token, {
		maxPages: ctx.memberPages,
	});
	budget.spend(Math.max(1, Math.ceil(members.length / 100)));
	if (truncated) {
		// Stamping builtAt off a truncated membership would freeze an undercount in place, and the
		// roll-up can't tell the difference later. Better to leave the org queued and loud.
		logger.warn(
			`org-backfill login=${login} status=members_truncated enumerated=${members.length} member_count=${profile.memberCount} member_pages=${ctx.memberPages}`,
		);
	}
	if (!dryRun) await opts.store.recordMembers(orgId, members);

	const alreadyFetched = ctx.force
		? new Set<string>()
		: await opts.store.fetchedMemberIds(orgId);
	const pending = members.filter(
		(m) => !alreadyFetched.has(userEntityId(m.login)),
	);
	result.membersSkipped += members.length - pending.length;
	logger.info(
		`org-backfill login=${login} source=${target.source} status=fetching members=${members.length} pending=${pending.length} already_done=${members.length - pending.length}`,
	);

	let fetched = 0;
	for (const member of pending) {
		const gate = checkGates({
			budget,
			maxRequests: ctx.maxRequests,
			runtimeLeftMs: ctx.runtimeLeftMs,
			progressed: hasProgress(result),
		});
		if (gate) {
			// Partial org: members already stored keep their `last_fetched`, so tomorrow's run
			// resumes here. builtAt stays null, which is what keeps it queued.
			result.orgsPartial += 1;
			logger.info(
				`org-backfill login=${login} status=partial fetched=${fetched} pending=${pending.length - fetched}`,
			);
			throw new StopRun(gate);
		}

		// A member can't have contributed to the org before either account existed.
		const start = new Date(
			Math.max(orgCreated.getTime(), new Date(member.createdAt).getTime()),
		);
		const windows = opts.yearlyWindows(start, ctx.now);
		const cost = Math.max(1, Math.ceil(windows.length / WINDOWS_PER_REQUEST));

		if (dryRun) {
			result.membersWouldFetch += 1;
			continue;
		}

		if (!(await budget.ensure())) {
			result.orgsPartial += 1;
			throw new StopRun("rate_limit_floor");
		}

		let totals: OrgMemberTotals = {
			commits: 0,
			issues: 0,
			pullRequests: 0,
			reviews: 0,
		};
		try {
			budget.spend(cost);
			totals = await opts.fetchOrgMemberContributions(
				member.login,
				profile.nodeId,
				opts.token,
				windows,
			);
			result.membersFetched += 1;
		} catch (err) {
			// Isolate per-member failures so one bad member can't sink the org:
			//   404 — deleted/renamed member, gone forever
			//   400 — a login our validator won't accept
			// Store zeros and mark it done so resume can't wedge on it. Everything else (rate
			// limits, 5xx) propagates: the org is abandoned for this run and retried later, rather
			// than persisting false zeros.
			if (
				!(
					err instanceof GitHubError &&
					(err.status === 404 || err.status === 400)
				)
			) {
				throw err;
			}
			result.membersFailed += 1;
			logger.warn(
				`org-backfill login=${login} member=${member.login} status=skipped http=${err.status}`,
			);
		}

		await opts.store.saveMemberTotals(
			orgId,
			userEntityId(member.login),
			totals,
			new Date(ctx.now.getTime()),
		);
		fetched += 1;
		await ctx.sleep((cost / ctx.ratePerHour) * 3_600_000);
	}

	if (dryRun) return;

	if (truncated) {
		// Everything we could see is stored, but the membership itself is incomplete — leave the
		// org queued so a later run (or a raised page cap) can finish it.
		result.orgsPartial += 1;
		return;
	}

	const totals = await opts.store.rollUpOrg(orgId, ctx.now);
	result.orgsFilled += 1;
	logger.info(
		`org-backfill login=${login} status=filled commits=${totals.commits} prs=${totals.pullRequests} reviews=${totals.reviews} issues=${totals.issues} members=${members.length}`,
	);
}

/**
 * The per-run caps. All three are "stop cleanly and leave the rest for the next run", and none of
 * them may fire before a single member is done: a run that stops having achieved nothing would
 * never make progress, it would just burn a scheduled slot every night.
 */
function checkGates(opts: {
	budget: BudgetGuard;
	maxRequests: number;
	runtimeLeftMs: () => number;
	progressed: boolean;
}): NonNullable<OrgBackfillResult["stopReason"]> | null {
	if (!opts.progressed) return null;
	if (opts.budget.spent() >= opts.maxRequests) return "max_requests";
	if (opts.runtimeLeftMs() <= 0) return "max_runtime";
	return null;
}

function hasProgress(result: OrgBackfillResult): boolean {
	return (
		result.membersFetched +
			result.membersFailed +
			result.membersWouldFetch +
			result.orgsFilled >
		0
	);
}

function stop(
	result: OrgBackfillResult,
	reason: NonNullable<OrgBackfillResult["stopReason"]>,
	logger: JobLogger,
): void {
	result.status = "stopped";
	result.stopReason = reason;
	logger.warn(`org-backfill status=stopped reason=${reason}`);
}

function emptyResult(dryRun: boolean): OrgBackfillResult {
	return {
		status: "completed",
		orgsAttempted: 0,
		orgsFilled: 0,
		orgsPartial: 0,
		orgsFailed: 0,
		membersFetched: 0,
		membersSkipped: 0,
		membersFailed: 0,
		membersWouldFetch: 0,
		requestsSpent: 0,
		queueRemaining: 0,
		dryRun,
	};
}
