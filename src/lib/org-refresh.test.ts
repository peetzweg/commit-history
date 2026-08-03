import { describe, expect, it } from "vitest";
import {
	GitHubError,
	type MonthWindow,
	type OrgMember,
	type OrgMemberTotals,
	type OrgProfile,
} from "#/lib/github";
import {
	currentMonthStart,
	type MemberWork,
	type OrgEnumerationTarget,
	type OrgRefreshStore,
	type RunOrgRefreshOptions,
	runOrgRefresh,
	userEntityId,
} from "#/lib/org-refresh";

const NOW = new Date("2026-08-15T06:00:00Z");
const MONTH_START = new Date("2026-08-01T00:00:00Z");
const LAST_MONTH = new Date("2026-07-20T00:00:00Z");

/**
 * In-memory stand-in for org_members + the org rows.
 *
 * `memberQueue` reimplements the store's round-robin ordering in TypeScript. That is deliberate:
 * it pins the *contract* the engine relies on (round-robin across orgs, never-fetched first) so a
 * change in either implementation shows up as a failing test. The production ordering is SQL —
 * see the `row_number() over (partition by org_id, …)` query in org-refresh-store.ts.
 */
class FakeStore implements OrgRefreshStore {
	locked = false;
	lockHeldElsewhere = false;
	released = 0;
	rolledUp: string[] = [];
	builtStamped: string[] = [];
	enumerated: Array<{ orgId: string; at: Date }> = [];
	orgs = new Map<
		string,
		{ login: string; membersEnumeratedAt: Date | null; builtAt: Date | null }
	>();
	members: Array<{
		orgId: string;
		memberId: string;
		login: string;
		lastFetched: Date | null;
	}> = [];

	constructor(
		orgs: Array<{
			login: string;
			enumeratedAt?: Date | null;
			members: Array<{ login: string; lastFetched?: Date | null }>;
		}>,
	) {
		for (const org of orgs) {
			const orgId = `org:${org.login.toLowerCase()}`;
			this.orgs.set(orgId, {
				login: org.login,
				membersEnumeratedAt: org.enumeratedAt ?? null,
				builtAt: null,
			});
			for (const m of org.members) {
				this.members.push({
					orgId,
					memberId: userEntityId(m.login),
					login: m.login,
					lastFetched: m.lastFetched ?? null,
				});
			}
		}
	}

	async tryLock() {
		if (this.lockHeldElsewhere) return false;
		this.locked = true;
		return true;
	}
	async releaseLock() {
		this.released += 1;
		this.locked = false;
	}

	async orgsNeedingEnumeration(since: Date, limit: number) {
		return [...this.orgs.entries()]
			.filter(
				([, o]) =>
					o.membersEnumeratedAt == null || o.membersEnumeratedAt < since,
			)
			.sort(([aId, a], [bId, b]) => {
				const at = a.membersEnumeratedAt?.getTime() ?? -1;
				const bt = b.membersEnumeratedAt?.getTime() ?? -1;
				return at - bt || aId.localeCompare(bId);
			})
			.slice(0, limit)
			.map(([id, o]): OrgEnumerationTarget => ({ id, login: o.login }));
	}

	async upsertOrgProfile(profile: OrgProfile) {
		const id = `org:${profile.login.toLowerCase()}`;
		if (!this.orgs.has(id)) {
			this.orgs.set(id, {
				login: profile.login,
				membersEnumeratedAt: null,
				builtAt: null,
			});
		}
		return id;
	}

	async recordMembers(orgId: string, members: OrgMember[], enumeratedAt: Date) {
		let discovered = 0;
		for (const m of members) {
			const memberId = userEntityId(m.login);
			if (
				this.members.some((r) => r.orgId === orgId && r.memberId === memberId)
			)
				continue;
			this.members.push({ orgId, memberId, login: m.login, lastFetched: null });
			discovered += 1;
		}
		const org = this.orgs.get(orgId);
		if (org) org.membersEnumeratedAt = enumeratedAt;
		this.enumerated.push({ orgId, at: enumeratedAt });
		return discovered;
	}

	async memberQueue({
		staleBefore,
		limit,
		logins,
	}: {
		staleBefore: Date;
		limit: number;
		logins?: string[];
	}) {
		const wanted = logins?.map((l) => `org:${l.toLowerCase()}`);
		const due = this.members.filter(
			(r) =>
				(r.lastFetched == null || r.lastFetched < staleBefore) &&
				(!wanted || wanted.includes(r.orgId)),
		);
		// rank within (org, never-fetched), exactly like the SQL window
		const ranked = due.map((row) => {
			const peers = due
				.filter(
					(o) =>
						o.orgId === row.orgId &&
						(o.lastFetched == null) === (row.lastFetched == null),
				)
				.sort(
					(a, b) =>
						(a.lastFetched?.getTime() ?? 0) - (b.lastFetched?.getTime() ?? 0) ||
						a.memberId.localeCompare(b.memberId),
				);
			return { row, rn: peers.indexOf(row) + 1 };
		});
		return ranked
			.sort(
				(a, b) =>
					Number(b.row.lastFetched == null) -
						Number(a.row.lastFetched == null) ||
					a.rn - b.rn ||
					a.row.orgId.localeCompare(b.row.orgId),
			)
			.slice(0, limit)
			.map(
				({ row }): MemberWork => ({
					orgId: row.orgId,
					orgLogin: this.orgs.get(row.orgId)?.login ?? row.orgId,
					orgNodeId: `node-${row.orgId}`,
					orgCreatedAt: new Date("2015-01-01T00:00:00Z"),
					memberId: row.memberId,
					memberLogin: row.login,
					memberCreatedAt: new Date("2018-01-01T00:00:00Z"),
				}),
			);
	}

	async countDueMembers(staleBefore: Date) {
		return this.members.filter(
			(r) => r.lastFetched == null || r.lastFetched < staleBefore,
		).length;
	}

	async saveMemberTotals(
		orgId: string,
		memberId: string,
		_totals: OrgMemberTotals,
		fetchedAt: Date,
	) {
		const row = this.members.find(
			(r) => r.orgId === orgId && r.memberId === memberId,
		);
		if (row) row.lastFetched = fetchedAt;
	}

	async rollUpOrgs(orgIds: string[], fetchedAt: Date) {
		this.rolledUp.push(...orgIds);
		for (const id of orgIds) {
			const pending = this.members.filter(
				(r) => r.orgId === id && r.lastFetched == null,
			).length;
			if (pending === 0) {
				const org = this.orgs.get(id);
				if (org) org.builtAt = fetchedAt;
				this.builtStamped.push(id);
			}
		}
	}
}

function profileFor(login: string, memberCount = 3): OrgProfile {
	return {
		nodeId: `node-org:${login.toLowerCase()}`,
		login,
		name: login,
		avatarUrl: "",
		htmlUrl: `https://github.com/${login}`,
		createdAt: "2015-01-01T00:00:00Z",
		description: null,
		websiteUrl: null,
		location: null,
		twitterUsername: null,
		isVerified: false,
		memberCount,
		publicRepos: 1,
	};
}

function memberOf(login: string): OrgMember {
	return {
		login,
		name: null,
		avatarUrl: "",
		createdAt: "2018-01-01T00:00:00Z",
		role: "MEMBER",
	};
}

const TOTALS: OrgMemberTotals = {
	commits: 5,
	issues: 1,
	pullRequests: 2,
	reviews: 3,
};

/** Options with every GitHub call stubbed to succeed and no pacing. */
function options(
	store: FakeStore,
	over: Partial<RunOrgRefreshOptions> = {},
): RunOrgRefreshOptions {
	return {
		store,
		token: "tok",
		now: NOW,
		fetchOrgProfile: async (login) => profileFor(login),
		fetchOrgMembers: async () => ({ members: [], truncated: false }),
		fetchOrgMemberContributions: async () => TOTALS,
		yearlyWindows: (): MonthWindow[] => [
			{
				label: "2015-01-01",
				from: "2015-01-01T00:00:00Z",
				to: "2016-01-01T00:00:00Z",
			},
		],
		sleep: async () => {},
		...over,
	};
}

describe("currentMonthStart", () => {
	it("is the start of the current month in UTC", () => {
		expect(
			currentMonthStart(new Date("2026-08-15T06:00:00Z")).toISOString(),
		).toBe("2026-08-01T00:00:00.000Z");
	});

	it("does not drift across a year boundary", () => {
		expect(
			currentMonthStart(new Date("2027-01-03T00:30:00Z")).toISOString(),
		).toBe("2027-01-01T00:00:00.000Z");
	});

	it("treats a timestamp in the first hours of the 1st as already the new month", () => {
		// The nightly run fires at 06:00 UTC on the 1st, so this is the real case: everything
		// refreshed during July is now stale and July is the last completed month.
		const boundary = currentMonthStart(new Date("2026-08-01T06:00:00Z"));
		expect(boundary.toISOString()).toBe("2026-08-01T00:00:00.000Z");
		expect(new Date("2026-07-31T23:00:00Z") < boundary).toBe(true);
	});
});

describe("runOrgRefresh member queue", () => {
	it("refreshes only rows that predate the current month", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: NOW,
				members: [
					{ login: "stale", lastFetched: LAST_MONTH },
					{ login: "current", lastFetched: new Date("2026-08-02T00:00:00Z") },
				],
			},
		]);
		const fetched: string[] = [];
		const result = await runOrgRefresh(
			options(store, {
				fetchOrgMemberContributions: async (login) => {
					fetched.push(login);
					return TOTALS;
				},
			}),
		);

		expect(fetched).toEqual(["stale"]);
		expect(result.membersFetched).toBe(1);
		expect(result.dueRemaining).toBe(0);
	});

	it("puts never-fetched members ahead of merely stale ones", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: NOW,
				members: [
					{ login: "stale", lastFetched: LAST_MONTH },
					{ login: "fresh-join", lastFetched: null },
				],
			},
		]);
		const fetched: string[] = [];
		await runOrgRefresh(
			options(store, {
				fetchOrgMemberContributions: async (login) => {
					fetched.push(login);
					return TOTALS;
				},
			}),
		);

		expect(fetched).toEqual(["fresh-join", "stale"]);
	});

	it("round-robins across orgs so a huge org cannot monopolise a run", async () => {
		// 1 big org and 2 small ones. Strict staleness would spend the whole budget inside `big`;
		// round-robin must give every org a turn before anyone's second member.
		const store = new FakeStore([
			{
				login: "big",
				enumeratedAt: NOW,
				members: Array.from({ length: 10 }, (_, i) => ({
					login: `big${i}`,
					lastFetched: LAST_MONTH,
				})),
			},
			{
				login: "mid",
				enumeratedAt: NOW,
				members: [
					{ login: "mid0", lastFetched: LAST_MONTH },
					{ login: "mid1", lastFetched: LAST_MONTH },
				],
			},
			{
				login: "small",
				enumeratedAt: NOW,
				members: [{ login: "small0", lastFetched: LAST_MONTH }],
			},
		]);
		const fetched: string[] = [];
		await runOrgRefresh(
			options(store, {
				// Budget for 4 members, so only the first round-robin pass plus one row lands.
				maxRequests: 4,
				fetchOrgMemberContributions: async (login) => {
					fetched.push(login);
					return TOTALS;
				},
			}),
		);

		// First three are one member from each org, not three from `big`.
		expect(fetched.slice(0, 3).sort()).toEqual(["big0", "mid0", "small0"]);
	});
});

describe("runOrgRefresh self-healing", () => {
	it("discovers a member who became visible after the org was built", async () => {
		// The #150 shape: the org is built and its known member is current, but GitHub now lists a
		// member we have never seen. Re-enumeration must find them and fetch them the same run.
		const store = new FakeStore([
			{
				login: "NixOS",
				enumeratedAt: LAST_MONTH,
				members: [{ login: "known", lastFetched: MONTH_START }],
			},
		]);
		const fetched: string[] = [];
		const result = await runOrgRefresh(
			options(store, {
				fetchOrgMembers: async () => ({
					members: [memberOf("known"), memberOf("Sigmanificient")],
					truncated: false,
				}),
				fetchOrgMemberContributions: async (login) => {
					fetched.push(login);
					return TOTALS;
				},
			}),
		);

		expect(result.orgsEnumerated).toBe(1);
		expect(result.membersDiscovered).toBe(1);
		expect(fetched).toEqual(["Sigmanificient"]);
		expect(result.dueRemaining).toBe(0);
	});

	it("never resets an existing member's progress when re-enumerating", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: LAST_MONTH,
				members: [{ login: "current", lastFetched: MONTH_START }],
			},
		]);
		await runOrgRefresh(
			options(store, {
				fetchOrgMembers: async () => ({
					members: [memberOf("current")],
					truncated: false,
				}),
			}),
		);

		const row = store.members.find((r) => r.memberId === "user:current");
		expect(row?.lastFetched).toEqual(MONTH_START);
	});

	it("stamps a truncated enumeration anyway so it cannot re-enumerate forever", async () => {
		// Leaving it unstamped would spend the pagination cost every single night while being
		// structurally unable to see more members. Stamp, count, and warn instead.
		const store = new FakeStore([
			{ login: "microsoft", enumeratedAt: LAST_MONTH, members: [] },
		]);
		const result = await runOrgRefresh(
			options(store, {
				fetchOrgMembers: async () => ({
					members: [memberOf("a")],
					truncated: true,
				}),
			}),
		);

		expect(result.orgsTruncated).toBe(1);
		expect(store.orgs.get("org:microsoft")?.membersEnumeratedAt).toEqual(NOW);
		// Second run in the same month must not re-enumerate it.
		const again = await runOrgRefresh(options(store));
		expect(again.orgsEnumerated).toBe(0);
	});
});

describe("runOrgRefresh caps and failure handling", () => {
	it("stops on the request cap and leaves the rest due", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: NOW,
				members: Array.from({ length: 6 }, (_, i) => ({
					login: `m${i}`,
					lastFetched: LAST_MONTH,
				})),
			},
		]);
		const result = await runOrgRefresh(options(store, { maxRequests: 3 }));

		expect(result.status).toBe("stopped");
		expect(result.stopReason).toBe("max_requests");
		expect(result.membersFetched).toBe(3);
		expect(result.dueRemaining).toBe(3);
	});

	it("never stops before achieving anything", async () => {
		// A cap of 1 must still fetch one member, or the job would burn its slot every night.
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: NOW,
				members: [
					{ login: "a", lastFetched: LAST_MONTH },
					{ login: "b", lastFetched: LAST_MONTH },
				],
			},
		]);
		const result = await runOrgRefresh(options(store, { maxRequests: 1 }));
		expect(result.membersFetched).toBeGreaterThanOrEqual(1);
	});

	it("stamps a 404 member done with zeros so it cannot wedge the queue", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: NOW,
				members: [{ login: "ghost", lastFetched: LAST_MONTH }],
			},
		]);
		const result = await runOrgRefresh(
			options(store, {
				fetchOrgMemberContributions: async () => {
					throw new GitHubError("gone", 404);
				},
			}),
		);

		expect(result.membersFailed).toBe(1);
		expect(result.membersFetched).toBe(0);
		expect(store.members[0].lastFetched).toEqual(NOW);
		expect(result.dueRemaining).toBe(0);
	});

	it("leaves a transient failure unstamped so the next run retries it", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: NOW,
				members: [
					{ login: "flaky", lastFetched: LAST_MONTH },
					{ login: "ok", lastFetched: LAST_MONTH },
				],
			},
		]);
		const result = await runOrgRefresh(
			options(store, {
				fetchOrgMemberContributions: async (login) => {
					if (login === "flaky") throw new GitHubError("boom", 502);
					return TOTALS;
				},
			}),
		);

		expect(result.membersFailed).toBe(1);
		expect(result.membersFetched).toBe(1);
		// Unchanged, not cleared: it keeps last month's timestamp, which is what leaves it due.
		const flaky = store.members.find((r) => r.memberId === "user:flaky");
		expect(flaky?.lastFetched).toEqual(LAST_MONTH);
		expect(result.dueRemaining).toBe(1);
	});

	it("gives up loudly when everything fails in a row", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: NOW,
				members: Array.from({ length: 10 }, (_, i) => ({
					login: `m${i}`,
					lastFetched: LAST_MONTH,
				})),
			},
		]);
		const result = await runOrgRefresh(
			options(store, {
				fetchOrgMemberContributions: async () => {
					throw new GitHubError("bad credentials", 401);
				},
			}),
		);

		expect(result.status).toBe("stopped");
		expect(result.stopReason).toBe("consecutive_failures");
		expect(result.membersFetched).toBe(0);
	});
});

describe("runOrgRefresh bookkeeping", () => {
	it("rolls up only the orgs it touched, and stamps builtAt once nothing is pending", async () => {
		const store = new FakeStore([
			{
				login: "touched",
				enumeratedAt: NOW,
				members: [{ login: "a", lastFetched: LAST_MONTH }],
			},
			{
				login: "untouched",
				enumeratedAt: NOW,
				members: [{ login: "b", lastFetched: MONTH_START }],
			},
		]);
		const result = await runOrgRefresh(options(store));

		expect(store.rolledUp).toEqual(["org:touched"]);
		expect(store.builtStamped).toEqual(["org:touched"]);
		expect(result.orgsRolledUp).toBe(1);
	});

	it("does not stamp builtAt while members are still pending", async () => {
		const store = new FakeStore([
			{
				login: "half",
				enumeratedAt: NOW,
				members: [
					{ login: "a", lastFetched: null },
					{ login: "b", lastFetched: null },
				],
			},
		]);
		await runOrgRefresh(options(store, { maxRequests: 1 }));

		expect(store.rolledUp).toEqual(["org:half"]);
		expect(store.builtStamped).toEqual([]);
		expect(store.orgs.get("org:half")?.builtAt).toBeNull();
	});

	it("does nothing and reports locked when another run holds the lock", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: NOW,
				members: [{ login: "a", lastFetched: LAST_MONTH }],
			},
		]);
		store.lockHeldElsewhere = true;
		const result = await runOrgRefresh(options(store));

		expect(result.status).toBe("locked");
		expect(result.membersFetched).toBe(0);
		expect(store.members[0].lastFetched).toEqual(LAST_MONTH);
	});

	it("releases the lock even when the run stops on a cap", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: NOW,
				members: Array.from({ length: 4 }, (_, i) => ({
					login: `m${i}`,
					lastFetched: LAST_MONTH,
				})),
			},
		]);
		await runOrgRefresh(options(store, { maxRequests: 2 }));

		expect(store.released).toBe(1);
		expect(store.locked).toBe(false);
	});

	it("writes nothing on a dry run but still reports the backlog", async () => {
		const store = new FakeStore([
			{
				login: "acme",
				enumeratedAt: LAST_MONTH,
				members: [{ login: "a", lastFetched: LAST_MONTH }],
			},
		]);
		const result = await runOrgRefresh(
			options(store, {
				dryRun: true,
				fetchOrgMembers: async () => ({
					members: [memberOf("a"), memberOf("new")],
					truncated: false,
				}),
			}),
		);

		expect(result.membersWouldFetch).toBe(1);
		expect(result.membersFetched).toBe(0);
		expect(result.dueRemaining).toBe(1);
		expect(store.members[0].lastFetched).toEqual(LAST_MONTH);
		expect(store.orgs.get("org:acme")?.membersEnumeratedAt).toEqual(LAST_MONTH);
		expect(store.rolledUp).toEqual([]);
	});
});

describe("runOrgRefresh named orgs", () => {
	it("refreshes every member regardless of freshness, and terminates", async () => {
		// Named runs ignore stored freshness, so the queue predicate must still exclude rows this
		// run has already stamped — otherwise the paging loop never ends.
		const store = new FakeStore([
			{
				login: "NixOS",
				enumeratedAt: NOW,
				members: [
					{ login: "a", lastFetched: MONTH_START },
					{ login: "b", lastFetched: new Date("2026-08-14T00:00:00Z") },
				],
			},
			{
				login: "other",
				enumeratedAt: NOW,
				members: [{ login: "c", lastFetched: LAST_MONTH }],
			},
		]);
		const fetched: string[] = [];
		const result = await runOrgRefresh(
			options(store, {
				logins: ["NixOS"],
				fetchOrgMemberContributions: async (login) => {
					fetched.push(login);
					return TOTALS;
				},
			}),
		);

		expect(fetched.sort()).toEqual(["a", "b"]);
		expect(result.status).toBe("completed");
		// The other org's stale member is left alone, and no enumeration happened.
		expect(result.orgsEnumerated).toBe(0);
		expect(
			store.members.find((r) => r.memberId === "user:c")?.lastFetched,
		).toEqual(LAST_MONTH);
	});
});
