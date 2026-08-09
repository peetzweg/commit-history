/**
 * Keeps every organization's numbers current, one bounded slice per nightly run.
 *
 * An org's totals are the sum of its members' contributions *to that org*, so keeping an org
 * current means keeping ~N member rows current. The unit of work here is therefore **one
 * (org, member) pair**, not one org — the single decision that makes this job well-behaved:
 *
 *   - No org is ever too big. microsoft is 4,373 queue entries, not an indivisible 7-hour job,
 *     so it advances every night and never restarts.
 *   - "Partly refreshed" is representable, because progress lives on the member rows
 *     (`org_members.last_fetched`) rather than in a per-org flag.
 *   - There is no force/resume distinction to get wrong. Staleness *is* the queue.
 *
 * Freshness target: **the last completed month**. A member row counts as current if it was read
 * at/after the start of the current UTC month, which means its totals include every finished
 * month — the org sibling of the `monthly_commits.fetched_at` gate on the user refresh (#151).
 * Every row falls out of currency on the 1st, so the queue refills itself and the job has no
 * terminal state it can get stuck in.
 *
 * Self-healing, by construction. Nothing here needs an operator to name an org:
 *   - members who joined, or made their membership public, are found by the monthly
 *     re-enumeration (`entities.members_enumerated_at`) — the #150 repair path;
 *   - a membership previously truncated by a page cap heals the same way, since the
 *     newly-visible members simply arrive as never-fetched queue entries;
 *   - departed members keep their rows and their contributions (#97);
 *   - a member GitHub has dropped stores zeros so it can't wedge the queue.
 *
 * Fairness: round-robin across orgs. Each pass takes every org's stalest member, then every org's
 * second-stalest, and so on, so all 595 orgs advance together at a uniform vintage and no single
 * org can monopolise a night. Never-fetched members outrank stale ones — an org showing nothing is
 * worse than an org showing last month's numbers — but they round-robin too, so repairing
 * microsoft cannot starve everyone else.
 *
 * Sizing, for reference: ~47k member rows at ~2 requests each is ~100k requests for a full sweep,
 * against a default 3,600/night. That is a complete refresh of every org roughly monthly, at
 * 1,200 requests/hour out of GitHub's 5,000/hour, with the live-traffic floor untouched.
 *
 * Only `entities` + `org_members` are written. Everything is an idempotent upsert, so a run that
 * stops on a cap is a success: tomorrow continues where it left off.
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
	positiveInteger,
	quietLogger,
} from "#/lib/job-runner";

export const orgEntityId = (login: string) =>
	`org:${login.trim().toLowerCase()}`;
export const userEntityId = (login: string) =>
	`user:${login.trim().toLowerCase()}`;

/**
 * `fetchOrgMemberContributions` batches this many yearly windows into one GraphQL request. Used
 * only to price a member (pacing + the per-run request cap), never for correctness:
 * over-estimating just spends the budget more conservatively.
 */
const WINDOWS_PER_REQUEST = 6;

/**
 * Stop the run after this many failures in a row. A systemic fault (bad token, missing read:org,
 * exhausted quota, GitHub outage) fails everything identically and in seconds, and a scheduled
 * task that exits 0 having achieved nothing is invisible in Coolify. `graphql()` already retries
 * transient statuses internally, so three consecutive failures past that is a real signal.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * One page of the member queue ≈ one round-robin sweep across the orgs that have due members.
 * Paged rather than fetched whole so a run never holds ~47,000 rows in memory, and so each page
 * reflects the writes of the one before it.
 */
const QUEUE_PAGE = 250;

/**
 * Start of the current UTC month. A marker at/after this proves the row includes every completed
 * month; anything earlier (or null) is due for a re-read.
 *
 * UTC is not incidental: months are UTC by definition here, and deriving the boundary from local
 * time would shift it by hours and re-refresh (or skip) a day's worth of rows around the 1st.
 */
export function currentMonthStart(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** An org whose membership is due for re-enumeration. */
export interface OrgEnumerationTarget {
	id: string;
	login: string;
}

/** One unit of work: fetch this member's contributions to this org. */
export interface MemberWork {
	orgId: string;
	orgLogin: string;
	orgNodeId: string;
	orgCreatedAt: Date;
	memberId: string;
	memberLogin: string;
	memberCreatedAt: Date | null;
}

export interface OrgRefreshStore {
	tryLock(): Promise<boolean>;
	releaseLock(): Promise<void>;
	/**
	 * Orgs not enumerated since `since`, least-recently-enumerated first. Nulls (never enumerated)
	 * come first — those are the orgs the request path recorded and refused to build.
	 */
	orgsNeedingEnumeration(
		since: Date,
		limit: number,
	): Promise<OrgEnumerationTarget[]>;
	/** Upsert the profile columns. Never stamps `builtAt` or `membersEnumeratedAt`. */
	upsertOrgProfile(profile: OrgProfile, fetchedAt: Date): Promise<string>;
	/**
	 * User stubs + `org_members` rows for the enumerated membership, then stamp
	 * `membersEnumeratedAt`. Idempotent: never overwrites a real user row, and never clears an
	 * existing member's totals — a re-enumeration only ever *adds*. Returns how many members were
	 * new, which is the joiners-and-healed-truncation count.
	 */
	recordMembers(
		orgId: string,
		members: OrgMember[],
		enumeratedAt: Date,
	): Promise<number>;
	/**
	 * The member work queue: rows whose `last_fetched` is null or older than `staleBefore`, in
	 * round-robin order across orgs, never-fetched first. `logins` restricts it to those orgs.
	 */
	memberQueue(opts: {
		staleBefore: Date;
		limit: number;
		logins?: string[];
	}): Promise<MemberWork[]>;
	/** How many member rows are still due — the summary line's convergence signal. */
	countDueMembers(staleBefore: Date): Promise<number>;
	saveMemberTotals(
		orgId: string,
		memberId: string,
		totals: OrgMemberTotals,
		fetchedAt: Date,
	): Promise<void>;
	/**
	 * Re-sum `org_members` onto each org row. Stamps `builtAt` only for orgs with no never-fetched
	 * member left, so a half-filled org still reads as unbuilt to the request path.
	 */
	rollUpOrgs(orgIds: string[], fetchedAt: Date): Promise<void>;
}

export interface RunOrgRefreshOptions {
	store: OrgRefreshStore;
	token: string;
	now?: Date;
	/**
	 * Refresh only these orgs, every member of them, regardless of stored freshness. A debug escape
	 * hatch ("why are NixOS's numbers wrong") — the nightly run passes nothing and needs nothing.
	 */
	logins?: string[];
	/** Per-run GraphQL request budget — one night's fair share of the shared token. */
	maxRequests?: number;
	/** Orgs to re-enumerate per run. Cheap (~1 request per 100 members) and it discovers the work. */
	maxEnumerations?: number;
	ratePerHour?: number;
	maxRuntimeMs?: number;
	/** Never spend the token's budget below this — headroom for live site traffic. */
	remainingFloor?: number;
	/** Requests between budget polls. The poll itself costs 0 points. */
	pollEvery?: number;
	/** Member pagination cap (pages of 100). Must clear GitHub's largest orgs — see #150. */
	memberPages?: number;
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

export interface OrgRefreshResult {
	status: "completed" | "locked" | "stopped";
	stopReason?:
		| "max_runtime"
		| "max_requests"
		| "rate_limit_floor"
		| "consecutive_failures";
	/** Memberships re-read from GitHub. */
	orgsEnumerated: number;
	/** Members discovered by this run's enumerations — joiners, or a healed truncation. */
	membersDiscovered: number;
	/** Enumerations that hit the page cap: those orgs undercount until `memberPages` is raised. */
	orgsTruncated: number;
	/** Enumerations that threw. Their orgs keep their old membership and are retried next run. */
	orgsFailed: number;
	membersFetched: number;
	/**
	 * Members that failed. A 404/400 stores zeros and is stamped done (it can never succeed, and
	 * leaving it unstamped would wedge the queue on it nightly); anything else is left unstamped so
	 * the next run retries it.
	 */
	membersFailed: number;
	membersWouldFetch: number;
	/** Orgs whose totals were re-summed at the end of the run. */
	orgsRolledUp: number;
	requestsSpent: number;
	/** Member rows still due after this run, or null if the count itself failed. */
	dueRemaining: number | null;
	dryRun: boolean;
}

/** Thrown to unwind out of the work loops when the run as a whole must stop. */
class StopRun extends Error {
	constructor(readonly reason: NonNullable<OrgRefreshResult["stopReason"]>) {
		super(`stop:${reason}`);
	}
}

export async function runOrgRefresh(
	opts: RunOrgRefreshOptions,
): Promise<OrgRefreshResult> {
	const now = opts.now ?? new Date();
	const dryRun = opts.dryRun ?? false;
	const logger = opts.logger ?? quietLogger;
	const maxRequests = positiveInteger(opts.maxRequests ?? 3600, "maxRequests");
	const maxEnumerations = positiveInteger(
		opts.maxEnumerations ?? 100,
		"maxEnumerations",
	);
	const ratePerHour = positiveInteger(opts.ratePerHour ?? 1200, "ratePerHour");
	const remainingFloor = positiveInteger(
		opts.remainingFloor ?? 500,
		"remainingFloor",
	);
	const pollEvery = positiveInteger(opts.pollEvery ?? 25, "pollEvery");
	const memberPages = positiveInteger(opts.memberPages ?? 60, "memberPages");
	const sleep = opts.sleep ?? defaultSleep;
	const timeMs = opts.timeMs ?? Date.now;
	const startedAt = timeMs();
	const runtimeLeftMs = () =>
		opts.maxRuntimeMs ? opts.maxRuntimeMs - (timeMs() - startedAt) : Infinity;

	const logins = opts.logins?.length ? opts.logins : undefined;
	// Named orgs refresh every member regardless of stored freshness. Using `now` as the boundary
	// gets that for free *and* keeps the loop finite: a row this run stamps with `now` is no longer
	// `< now`, so it drops out of the next page instead of coming back forever.
	const staleBefore = logins ? now : currentMonthStart(now);

	logger.info(
		`org-refresh startup utc_now=${now.toISOString()} stale_before=${staleBefore.toISOString()} dry_run=${dryRun}${logins ? ` logins=${logins.join(",")}` : ""} max_requests=${maxRequests} max_enumerations=${maxEnumerations} rate_per_hour=${ratePerHour} remaining_floor=${opts.fetchRateLimit ? remainingFloor : "unenforced"} poll_every=${pollEvery} member_pages=${memberPages} max_runtime_minutes=${opts.maxRuntimeMs ? Math.round(opts.maxRuntimeMs / 60_000) : "none"}`,
	);

	const result = emptyResult(dryRun);

	const locked = await opts.store.tryLock();
	if (!locked) {
		logger.warn("org-refresh status=locked lock=held_elsewhere");
		result.status = "locked";
		return result;
	}

	const budget = createBudgetGuard({
		label: "org-refresh",
		remainingFloor,
		pollEvery,
		fetchRateLimit: opts.fetchRateLimit,
		sleep,
		nowMs: timeMs,
		runtimeLeftMs,
		logger,
	});

	// Orgs whose stored numbers moved this run, so the closing roll-up only re-sums what changed.
	const touched = new Set<string>();
	const ctx: Ctx = {
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
		touched,
		opts,
	};

	try {
		// Phase 1 — re-read memberships. First because it *discovers* work: a joiner (or a member
		// revealed by a raised page cap) becomes a never-fetched row that phase 2 then prioritises.
		// Skipped for named orgs: naming an org means refreshing its numbers, not hunting joiners.
		if (!logins) await enumerate(ctx, currentMonthStart(now), maxEnumerations);
		// Phase 2 — drain the member queue in round-robin order until a cap stops us.
		await refreshMembers(ctx, staleBefore, logins);
	} catch (err) {
		if (err instanceof StopRun) {
			stop(result, err.reason, logger);
		} else {
			// Nothing should reach here — both loops isolate their own failures — but a throw that
			// escaped must not skip the roll-up and lock release in `finally`, nor lose the summary
			// line. Log it and let the caller see a run that achieved nothing.
			logger.error(
				`org-refresh status=unhandled error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
			);
			result.status = "stopped";
		}
	} finally {
		result.requestsSpent = budget.spent();
		// Roll up before releasing the lock: these writes are the point of the run, and a member
		// total that never reaches the org's `entities` row is invisible on the site. Best-effort —
		// a failure here must not mask the work that did land.
		if (!dryRun && touched.size > 0) {
			try {
				await opts.store.rollUpOrgs([...touched], now);
				result.orgsRolledUp = touched.size;
			} catch (err) {
				logger.error(
					`org-refresh status=rollup_failed orgs=${touched.size} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
				);
			}
		}
		// Release the lock defensively and never let cleanup throw. A query that fails in here (a
		// blipped connection is enough) would otherwise skip `pg_advisory_unlock`, leaving the lock
		// held by a server-side session that outlives the process — every later run then reports
		// status=locked and quietly does nothing. Silent and self-perpetuating.
		try {
			await opts.store.releaseLock();
		} catch (err) {
			logger.error(
				`org-refresh status=lock_release_failed error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
			);
		}
		// Reporting only, so it must not be able to sink the run.
		try {
			result.dueRemaining = await opts.store.countDueMembers(
				currentMonthStart(now),
			);
		} catch {
			result.dueRemaining = null;
		}
	}

	logger.info(
		`org-refresh done status=${result.status}${result.stopReason ? ` reason=${result.stopReason}` : ""} orgs_enumerated=${result.orgsEnumerated} members_discovered=${result.membersDiscovered} orgs_truncated=${result.orgsTruncated} orgs_failed=${result.orgsFailed} members_fetched=${result.membersFetched} members_failed=${result.membersFailed}${dryRun ? ` members_would_fetch=${result.membersWouldFetch}` : ""} orgs_rolled_up=${result.orgsRolledUp} requests_spent=${result.requestsSpent} due_remaining=${result.dueRemaining ?? "unknown"} dry_run=${dryRun}`,
	);
	return result;
}

interface Ctx {
	now: Date;
	dryRun: boolean;
	memberPages: number;
	maxRequests: number;
	ratePerHour: number;
	budget: BudgetGuard;
	runtimeLeftMs: () => number;
	sleep: (ms: number) => Promise<void>;
	logger: JobLogger;
	result: OrgRefreshResult;
	touched: Set<string>;
	opts: RunOrgRefreshOptions;
}

/**
 * Re-read the membership of orgs not enumerated this month. Cheap — one profile request plus one
 * per 100 members — and it is the only thing that can discover a member who joined, or who made an
 * existing membership public, after the org's initial build (#150).
 */
async function enumerate(ctx: Ctx, since: Date, limit: number): Promise<void> {
	const { opts, logger, result } = ctx;
	const targets = await opts.store.orgsNeedingEnumeration(since, limit);
	logger.info(`org-refresh phase=enumerate orgs=${targets.length}`);

	let consecutiveFailures = 0;
	for (const target of targets) {
		const gate = checkGates(ctx);
		if (gate) throw new StopRun(gate);

		try {
			if (!(await ctx.budget.ensure())) throw new StopRun("rate_limit_floor");
			const profile = await opts.fetchOrgProfile(target.login, opts.token);
			ctx.budget.spend(1);

			if (!(await ctx.budget.ensure())) throw new StopRun("rate_limit_floor");
			const { members, truncated } = await opts.fetchOrgMembers(
				target.login,
				opts.token,
				{ maxPages: ctx.memberPages },
			);
			ctx.budget.spend(Math.max(1, Math.ceil(members.length / 100)));

			if (truncated) {
				// Stamped anyway, deliberately. Leaving it unstamped would re-enumerate this org on
				// every run forever — dozens of requests a night that can never reveal more members,
				// because the cap is what's stopping us, not the cursor. The org's totals undercount
				// until `memberPages` is raised, and this line is the signal to raise it.
				result.orgsTruncated += 1;
				logger.warn(
					`org-refresh login=${target.login} status=members_truncated enumerated=${members.length} member_count=${profile.memberCount} member_pages=${ctx.memberPages}`,
				);
			}

			let discovered = 0;
			if (!ctx.dryRun) {
				const orgId = await opts.store.upsertOrgProfile(profile, ctx.now);
				discovered = await opts.store.recordMembers(orgId, members, ctx.now);
				result.membersDiscovered += discovered;
				// A re-enumeration that added nobody leaves the stored totals valid, so there is
				// nothing to re-sum. Only a membership that actually moved needs a roll-up.
				if (discovered > 0) ctx.touched.add(orgId);
			}
			result.orgsEnumerated += 1;
			consecutiveFailures = 0;
			logger.info(
				`org-refresh login=${target.login} status=enumerated members=${members.length} discovered=${discovered} member_count=${profile.memberCount}`,
			);
		} catch (err) {
			if (err instanceof StopRun) throw err;
			result.orgsFailed += 1;
			consecutiveFailures += 1;
			const status = err instanceof GitHubError ? err.status : undefined;
			logger.error(
				`org-refresh login=${target.login} status=enumerate_failed${status ? ` http=${status}` : ""} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
			);
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				throw new StopRun("consecutive_failures");
			}
		}
	}
}

/**
 * Drain the member work queue. The store hands back rows already in round-robin order, a page at a
 * time, and a page is re-read after the previous one's writes — so a row stamped this run drops out
 * rather than reappearing.
 */
async function refreshMembers(
	ctx: Ctx,
	staleBefore: Date,
	logins: string[] | undefined,
): Promise<void> {
	const { opts, logger, result } = ctx;
	let consecutiveFailures = 0;
	let page = 0;
	// Rows this run has already tried. A successful (or permanently-failed) row is stamped and drops
	// out of the next page on its own, but a row left unstamped for a later retry would come straight
	// back — so without this the run re-attempts the same failing member until it happens to trip the
	// consecutive-failure limit. Also guarantees termination: the set only grows, and it is bounded.
	const attempted = new Set<string>();

	while (true) {
		const page_ = await opts.store.memberQueue({
			staleBefore,
			limit: QUEUE_PAGE,
			logins,
		});
		const work = page_.filter((w) => !attempted.has(`${w.orgId} ${w.memberId}`));
		if (work.length === 0) break;
		page += 1;
		logger.info(`org-refresh phase=members page=${page} rows=${work.length}`);

		for (const item of work) {
			attempted.add(`${item.orgId} ${item.memberId}`);
			const gate = checkGates(ctx);
			if (gate) throw new StopRun(gate);

			// A member can't have contributed to the org before either account existed.
			const start = new Date(
				Math.max(
					item.orgCreatedAt.getTime(),
					item.memberCreatedAt?.getTime() ?? item.orgCreatedAt.getTime(),
				),
			);
			const windows = opts.yearlyWindows(start, ctx.now);
			const cost = Math.max(1, Math.ceil(windows.length / WINDOWS_PER_REQUEST));

			if (ctx.dryRun) {
				result.membersWouldFetch += 1;
				continue;
			}

			if (!(await ctx.budget.ensure())) throw new StopRun("rate_limit_floor");

			let totals: OrgMemberTotals;
			try {
				ctx.budget.spend(cost);
				totals = await opts.fetchOrgMemberContributions(
					item.memberLogin,
					item.orgNodeId,
					opts.token,
					windows,
				);
				result.membersFetched += 1;
				consecutiveFailures = 0;
			} catch (err) {
				result.membersFailed += 1;
				const permanent =
					err instanceof GitHubError &&
					(err.status === 404 || err.status === 400);
				if (!permanent) {
					// Transient (rate limit, 5xx past graphql()'s own retries) or unexpected. Leave the
					// row unstamped so the next run retries it, and move on — one bad member must not
					// end a run that is otherwise making progress. Three in a row is a systemic fault.
					consecutiveFailures += 1;
					logger.warn(
						`org-refresh login=${item.orgLogin} member=${item.memberLogin} status=retry_later${err instanceof GitHubError ? ` http=${err.status}` : ""} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
					);
					if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
						throw new StopRun("consecutive_failures");
					}
					continue;
				}
				// 404/400: deleted, renamed, or a login our validator won't accept. It can never
				// succeed, so store zeros and stamp it done — otherwise the queue wedges on it every
				// single night.
				consecutiveFailures = 0;
				logger.warn(
					`org-refresh login=${item.orgLogin} member=${item.memberLogin} status=skipped http=${err.status}`,
				);
				totals = { commits: 0, issues: 0, pullRequests: 0, reviews: 0 };
			}

			// Stamped with the run's `now`, not per-row wall clock: the marker means "includes every
			// month completed before this run started", which is a property of the run, not the row.
			await opts.store.saveMemberTotals(
				item.orgId,
				item.memberId,
				totals,
				ctx.now,
			);
			ctx.touched.add(item.orgId);
			await ctx.sleep((cost / ctx.ratePerHour) * 3_600_000);
		}

		// A dry run writes nothing, so the same page would come back forever. One page is enough to
		// show the shape of the work; `due_remaining` in the summary reports the real total.
		if (ctx.dryRun) break;
	}
}

/**
 * The per-run caps. Both are "stop cleanly and leave the rest for the next run", and neither may
 * fire before the run has achieved something: a run that stops having done nothing would just burn
 * a scheduled slot every night.
 */
function checkGates(
	ctx: Ctx,
): NonNullable<OrgRefreshResult["stopReason"]> | null {
	const progressed =
		ctx.result.membersFetched > 0 || ctx.result.orgsEnumerated > 0;
	if (!progressed) return null;
	if (ctx.budget.spent() >= ctx.maxRequests) return "max_requests";
	if (ctx.runtimeLeftMs() <= 0) return "max_runtime";
	return null;
}

function stop(
	result: OrgRefreshResult,
	reason: NonNullable<OrgRefreshResult["stopReason"]>,
	logger: JobLogger,
): void {
	result.status = "stopped";
	result.stopReason = reason;
	logger.info(`org-refresh status=stopping reason=${reason}`);
}

function emptyResult(dryRun: boolean): OrgRefreshResult {
	return {
		status: "completed",
		orgsEnumerated: 0,
		membersDiscovered: 0,
		orgsTruncated: 0,
		orgsFailed: 0,
		membersFetched: 0,
		membersFailed: 0,
		membersWouldFetch: 0,
		orgsRolledUp: 0,
		requestsSpent: 0,
		dueRemaining: null,
		dryRun,
	};
}
