import { describe, expect, it } from "vitest";
import {
	GitHubError,
	type MonthWindow,
	type OrgMember,
	type OrgMemberTotals,
	type OrgProfile,
} from "#/lib/github";
import {
	type OrgBackfillStore,
	type OrgBackfillTarget,
	orgEntityId,
	runOrgBackfill,
	userEntityId,
} from "#/lib/org-backfill";

const NOW = new Date("2026-08-02T06:00:00Z");

function profile(login: string, memberCount: number): OrgProfile {
	return {
		login,
		nodeId: `node-${login}`,
		name: login,
		avatarUrl: `https://avatars/${login}`,
		htmlUrl: `https://github.com/${login}`,
		createdAt: "2015-01-01T00:00:00Z",
		description: null,
		websiteUrl: null,
		location: null,
		twitterUsername: null,
		isVerified: false,
		memberCount,
		publicRepos: 10,
	};
}

function member(login: string): OrgMember {
	return {
		login,
		name: login,
		avatarUrl: `https://avatars/${login}`,
		createdAt: "2018-01-01T00:00:00Z",
		role: "MEMBER",
	};
}

const totals = (commits: number): OrgMemberTotals => ({
	commits,
	issues: 0,
	pullRequests: 0,
	reviews: 0,
});

class FakeStore implements OrgBackfillStore {
	unfilled: OrgBackfillTarget[] = [];
	stale: OrgBackfillTarget[] = [];
	staleQueriedBefore: Date | null = null;
	readonly profiles: string[] = [];
	readonly recorded = new Map<string, OrgMember[]>();
	readonly memberTotals = new Map<string, OrgMemberTotals>();
	readonly rolledUp: string[] = [];
	/** Pre-seeded "already fetched" member ids per org, i.e. a previous run's progress. */
	readonly done = new Map<string, Set<string>>();
	/** Cleanup call order, so tests can assert the lock is released first. */
	readonly teardown: string[] = [];

	async tryLock() {
		return true;
	}

	async releaseLock() {
		this.teardown.push("releaseLock");
	}

	async unfilledOrgs(limit: number) {
		return this.unfilled.slice(0, limit);
	}

	async staleOrgs(builtBefore: Date, limit: number) {
		this.staleQueriedBefore = builtBefore;
		return this.stale.slice(0, limit);
	}

	async countUnfilled() {
		this.teardown.push("countUnfilled");
		return this.unfilled.filter((o) => !this.rolledUp.includes(o.id ?? ""))
			.length;
	}

	async upsertOrgProfile(p: OrgProfile) {
		this.profiles.push(p.login);
		return orgEntityId(p.login);
	}

	async recordMembers(orgId: string, members: OrgMember[]) {
		this.recorded.set(orgId, members);
	}

	async fetchedMemberIds(orgId: string) {
		return new Set(this.done.get(orgId) ?? []);
	}

	async saveMemberTotals(orgId: string, memberId: string, t: OrgMemberTotals) {
		this.memberTotals.set(`${orgId}/${memberId}`, t);
		const set = this.done.get(orgId) ?? new Set<string>();
		set.add(memberId);
		this.done.set(orgId, set);
	}

	async rollUpOrg(orgId: string) {
		this.rolledUp.push(orgId);
		let commits = 0;
		for (const [key, t] of this.memberTotals) {
			if (key.startsWith(`${orgId}/`)) commits += t.commits;
		}
		return totals(commits);
	}
}

/** Two yearly windows per member => 1 request each at WINDOWS_PER_REQUEST=6. */
const windows: MonthWindow[] = [
	{ from: "2024-01-01T00:00:00Z", to: "2024-12-31T23:59:59Z", label: "2024" },
	{ from: "2025-01-01T00:00:00Z", to: "2025-12-31T23:59:59Z", label: "2025" },
];

function harness(
	store: FakeStore,
	members: Record<string, OrgMember[]>,
	overrides: Partial<Parameters<typeof runOrgBackfill>[0]> = {},
) {
	const fetched: string[] = [];
	const slept: number[] = [];
	return {
		fetched,
		slept,
		run: (extra: Partial<Parameters<typeof runOrgBackfill>[0]> = {}) =>
			runOrgBackfill({
				store,
				token: "token",
				now: NOW,
				sleep: async (ms) => {
					slept.push(ms);
				},
				yearlyWindows: () => windows,
				fetchOrgProfile: async (login) =>
					profile(login, members[login]?.length ?? 0),
				fetchOrgMembers: async (login) => ({
					members: members[login] ?? [],
					truncated: false,
				}),
				fetchOrgMemberContributions: async (login) => {
					fetched.push(login);
					return totals(1);
				},
				...overrides,
				...extra,
			}),
	};
}

const target = (
	login: string,
	memberCount: number,
	source: OrgBackfillTarget["source"] = "unfilled",
): OrgBackfillTarget => ({
	id: orgEntityId(login),
	login,
	memberCount,
	source,
});

describe("runOrgBackfill", () => {
	it("fills the queue smallest first and stamps builtAt only on completion", async () => {
		const store = new FakeStore();
		store.unfilled = [target("small", 2), target("larger", 3)];
		const h = harness(store, {
			small: [member("ada"), member("grace")],
			larger: [member("linus"), member("ken"), member("rob")],
		});

		const result = await h.run();

		expect(h.fetched).toEqual(["ada", "grace", "linus", "ken", "rob"]);
		expect(store.rolledUp).toEqual([
			orgEntityId("small"),
			orgEntityId("larger"),
		]);
		expect(result).toMatchObject({
			status: "completed",
			orgsAttempted: 2,
			orgsFilled: 2,
			orgsPartial: 0,
			membersFetched: 5,
			membersSkipped: 0,
		});
	});

	it("resumes past members a previous run already fetched", async () => {
		const store = new FakeStore();
		store.unfilled = [target("jupyter", 3)];
		store.done.set(
			orgEntityId("jupyter"),
			new Set([userEntityId("ada"), userEntityId("grace")]),
		);
		const h = harness(store, {
			jupyter: [member("ada"), member("grace"), member("linus")],
		});

		const result = await h.run();

		expect(h.fetched).toEqual(["linus"]);
		expect(result.membersSkipped).toBe(2);
		expect(result.membersFetched).toBe(1);
		expect(store.rolledUp).toEqual([orgEntityId("jupyter")]);
	});

	it("stops at the per-run request cap mid-org and leaves it queued", async () => {
		const store = new FakeStore();
		store.unfilled = [target("mega", 6)];
		const h = harness(store, {
			mega: ["a", "b", "c", "d", "e", "f"].map(member),
		});

		// 1 profile + 1 enumeration + 1 per member: the cap bites after the third member.
		const result = await h.run({ maxRequests: 5 });

		expect(h.fetched).toEqual(["a", "b", "c"]);
		expect(result.status).toBe("stopped");
		expect(result.stopReason).toBe("max_requests");
		expect(result.orgsPartial).toBe(1);
		expect(result.orgsFilled).toBe(0);
		// Not stamped: the org stays in the queue for tomorrow's run.
		expect(store.rolledUp).toEqual([]);
		// The three members that did land keep their totals, which is what makes resume work.
		expect(store.memberTotals.size).toBe(3);
	});

	it("stops at the wall-clock cap", async () => {
		const store = new FakeStore();
		store.unfilled = [target("mega", 4)];
		const h = harness(store, { mega: ["a", "b", "c", "d"].map(member) });
		let clock = 0;

		const result = await h.run({
			maxRuntimeMs: 10_000,
			timeMs: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
			ratePerHour: 360, // 10s per request, so the cap trips after the first member
		});

		expect(h.fetched).toEqual(["a"]);
		expect(result.stopReason).toBe("max_runtime");
		expect(result.orgsPartial).toBe(1);
	});

	it("keeps going when a member is gone from GitHub, storing zeros", async () => {
		const store = new FakeStore();
		store.unfilled = [target("org", 2)];
		const h = harness(store, { org: [member("deleted"), member("ada")] });

		const result = await h.run({
			fetchOrgMemberContributions: async (login) => {
				if (login === "deleted") throw new GitHubError("gone", 404);
				return totals(7);
			},
		});

		expect(result.membersFailed).toBe(1);
		expect(result.membersFetched).toBe(1);
		expect(
			store.memberTotals.get(
				`${orgEntityId("org")}/${userEntityId("deleted")}`,
			),
		).toEqual(totals(0));
		// The org still completes: a permanently dead member must not wedge the queue.
		expect(store.rolledUp).toEqual([orgEntityId("org")]);
	});

	it("abandons an org on a rate limit without storing false zeros", async () => {
		const store = new FakeStore();
		store.unfilled = [target("org", 2)];
		const h = harness(store, { org: [member("ada"), member("grace")] });

		const result = await h.run({
			fetchOrgMemberContributions: async (login) => {
				if (login === "grace") throw new GitHubError("rate limited", 429);
				return totals(3);
			},
		});

		expect(result.orgsFailed).toBe(1);
		expect(store.memberTotals.size).toBe(1);
		expect(store.rolledUp).toEqual([]);
	});

	it("gives up loudly when every org fails and nothing is fetched", async () => {
		const store = new FakeStore();
		store.unfilled = [
			target("a", 1),
			target("b", 1),
			target("c", 1),
			target("d", 1),
		];
		const h = harness(store, {});

		const result = await h.run({
			// A bad token fails identically on every org, in seconds.
			fetchOrgProfile: async () => {
				throw new GitHubError("Bad credentials", 401);
			},
		});

		expect(result.status).toBe("stopped");
		expect(result.stopReason).toBe("consecutive_failures");
		expect(result.orgsAttempted).toBe(3);
		expect(result.membersFetched).toBe(0);
	});

	it("leaves a truncated membership queued instead of freezing an undercount", async () => {
		const store = new FakeStore();
		store.unfilled = [target("epic", 2827)];
		const h = harness(store, { epic: [member("ada")] });

		const result = await h.run({
			fetchOrgMembers: async () => ({
				members: [member("ada")],
				truncated: true,
			}),
		});

		expect(result.membersFetched).toBe(1);
		expect(result.orgsPartial).toBe(1);
		expect(result.orgsFilled).toBe(0);
		expect(store.rolledUp).toEqual([]);
	});

	it("writes nothing during a dry run", async () => {
		const store = new FakeStore();
		store.unfilled = [target("org", 2)];
		const h = harness(store, { org: [member("ada"), member("grace")] });

		const result = await h.run({ dryRun: true });

		expect(h.fetched).toEqual([]);
		expect(result.membersWouldFetch).toBe(2);
		expect(store.profiles).toEqual([]);
		expect(store.recorded.size).toBe(0);
		expect(store.memberTotals.size).toBe(0);
		expect(store.rolledUp).toEqual([]);
	});

	it("only reaches the staleness rotation once nothing is unfilled", async () => {
		const store = new FakeStore();
		store.unfilled = [target("pending", 1)];
		store.stale = [target("old", 1, "stale")];
		const h = harness(store, {
			pending: [member("ada")],
			old: [member("grace")],
		});

		const withQueue = await h.run({ staleAfterDays: 90, maxStaleOrgs: 5 });
		expect(h.fetched).toEqual(["ada"]);
		expect(store.staleQueriedBefore).toBeNull();
		expect(withQueue.orgsFilled).toBe(1);

		store.unfilled = [];
		const drained = await h.run({ staleAfterDays: 90, maxStaleOrgs: 5 });
		expect(h.fetched).toEqual(["ada", "grace"]);
		expect(store.staleQueriedBefore?.toISOString()).toBe(
			"2026-05-04T06:00:00.000Z",
		);
		expect(drained.orgsFilled).toBe(1);
	});

	it("re-fetches every member of a stale org, ignoring the resume marker", async () => {
		const store = new FakeStore();
		store.stale = [target("old", 2, "stale")];
		store.done.set(
			orgEntityId("old"),
			new Set([userEntityId("ada"), userEntityId("grace")]),
		);
		const h = harness(store, { old: [member("ada"), member("grace")] });

		const result = await h.run({ staleAfterDays: 30, maxStaleOrgs: 1 });

		expect(h.fetched).toEqual(["ada", "grace"]);
		expect(result.membersSkipped).toBe(0);
	});

	it("releases the lock before any other cleanup query", async () => {
		const store = new FakeStore();
		store.unfilled = [target("org", 1)];
		const h = harness(store, { org: [member("ada")] });

		await h.run();

		// Anything ordered after the release can fail and skip pg_advisory_unlock, which leaves the
		// lock held by a session that outlives the process and wedges every later run.
		expect(store.teardown).toEqual(["releaseLock", "countUnfilled"]);
	});

	it("still reports a finished run when the queue count fails", async () => {
		const store = new FakeStore();
		store.unfilled = [target("org", 1)];
		store.countUnfilled = async () => {
			throw new Error("connection closed");
		};
		const h = harness(store, { org: [member("ada")] });

		const result = await h.run();

		expect(result.status).toBe("completed");
		expect(result.orgsFilled).toBe(1);
		expect(result.queueRemaining).toBeNull();
	});

	it("does not start when another run holds the lock", async () => {
		const store = new FakeStore();
		store.unfilled = [target("org", 1)];
		store.tryLock = async () => false;
		const h = harness(store, { org: [member("ada")] });

		const result = await h.run();

		expect(result.status).toBe("locked");
		expect(h.fetched).toEqual([]);
	});

	it("stops rather than spending below the reserved budget floor", async () => {
		const store = new FakeStore();
		store.unfilled = [target("org", 2)];
		const h = harness(store, { org: [member("ada"), member("grace")] });
		const clock = 1_800_000_000_000;

		const result = await h.run({
			remainingFloor: 500,
			pollEvery: 1,
			maxRuntimeMs: 10 * 60_000,
			timeMs: () => clock,
			// Window resets in 50 minutes, well past the runtime budget, so waiting is not an option.
			fetchRateLimit: async () => ({
				remaining: 12,
				resetAt: new Date(clock + 50 * 60_000).toISOString(),
			}),
		});

		expect(h.fetched).toEqual([]);
		expect(result.status).toBe("stopped");
		expect(result.stopReason).toBe("rate_limit_floor");
		expect(store.memberTotals.size).toBe(0);
	});

	it("paces each member by its request cost", async () => {
		const store = new FakeStore();
		store.unfilled = [target("org", 1)];
		const h = harness(store, { org: [member("ada")] });

		await h.run({ ratePerHour: 1200 });

		// 1 request at 1200/hr = 3s.
		expect(h.slept).toEqual([3_000]);
	});
});
