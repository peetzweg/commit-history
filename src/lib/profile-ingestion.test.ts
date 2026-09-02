import { describe, expect, it } from "vitest";
import type {
	CommitHistory,
	MonthlyCount,
	MonthWindow,
	Profile,
	RateLimitBudget,
} from "#/lib/github";
import {
	createProfileIngestion,
	isStoredProfileMonthComplete,
	type ProfileIngestionGitHub,
	type ProfileIngestionStore,
	type StoredProfile,
	type StoredProfileMonth,
} from "#/lib/profile-ingestion-engine";

const NOW = new Date("2026-05-15T12:00:00.000Z");
const TARGET = { login: "fresh", githubNodeId: "U_fresh" };
const PROFILE: Profile = {
	nodeId: TARGET.githubNodeId,
	login: TARGET.login,
	name: "Fresh Profile",
	avatarUrl: "https://avatars.example/fresh",
	createdAt: "2026-01-10T00:00:00.000Z",
	bio: null,
	company: null,
	location: null,
	websiteUrl: null,
	twitterUsername: null,
	followers: 12,
	following: 4,
	publicRepos: 3,
};

const counts = (commits: number): MonthlyCount => ({
	commits,
	restricted: commits * 2,
	issues: commits * 3,
	pullRequests: commits * 4,
	reviews: commits * 5,
	repos: commits * 6,
});

class MemoryStore implements ProfileIngestionStore {
	readonly profiles = new Map<string, StoredProfile>();
	readonly months = new Map<string, Map<string, StoredProfileMonth>>();
	readonly completions: CommitHistory[] = [];
	readonly unreachable: string[] = [];

	async findProfile(target: { login: string; githubNodeId?: string }) {
		if (target.githubNodeId) {
			return [...this.profiles.values()].find(
				(row) => row.profile.nodeId === target.githubNodeId,
			);
		}
		const matches = [...this.profiles.values()].filter(
			(row) => row.profile.login.toLowerCase() === target.login.toLowerCase(),
		);
		return matches.length === 1 ? matches[0] : undefined;
	}

	async saveProfile(profile: Profile) {
		const existing = [...this.profiles.values()].find(
			(row) => row.profile.nodeId === profile.nodeId,
		);
		if (existing) {
			existing.profile = profile;
			return existing;
		}
		const entityId = `github-user:${profile.nodeId}`;
		const stored = {
			entityId,
			profile,
			builtAt: null,
			lastFetched: null,
		};
		this.profiles.set(entityId, stored);
		return stored;
	}

	async storedMonths(entityId: string) {
		return [...(this.months.get(entityId)?.values() ?? [])];
	}

	async saveMonths(
		entityId: string,
		months: StoredProfileMonth[],
		_fetchedAt: Date,
	) {
		const stored = this.months.get(entityId) ?? new Map();
		for (const month of months) stored.set(month.month, month);
		this.months.set(entityId, stored);
	}

	async markComplete(
		entityId: string,
		history: CommitHistory,
		expectedMonths: string[],
		at: Date,
	) {
		const row = this.profiles.get(entityId);
		if (!row) throw new Error("profile missing");
		const storedMonths = this.months.get(entityId) ?? new Map();
		const missing = expectedMonths.filter((month) => {
			const storedMonth = storedMonths.get(month);
			return (
				!storedMonth || !isStoredProfileMonthComplete(storedMonth, row.builtAt)
			);
		});
		if (missing.length > 0) throw new Error("months are not durable");
		row.builtAt ??= at;
		row.lastFetched = at;
		row.profile = history.user;
		this.completions.push(history);
	}

	async markUnreachable(entityId: string) {
		this.unreachable.push(entityId);
	}
}

class FakeGitHub implements ProfileIngestionGitHub {
	readonly fetchedChunks: string[][] = [];
	profile = PROFILE;
	budget: RateLimitBudget | null = {
		remaining: 5_000,
		resetAt: "2026-05-15T13:00:00.000Z",
	};
	monthCalls = 0;
	profileCalls = 0;
	failMonthCall: number | null = null;

	async fetchProfileByLogin() {
		this.profileCalls += 1;
		return this.profile;
	}

	async fetchProfileByNodeId() {
		this.profileCalls += 1;
		return this.profile;
	}

	async fetchMonthlyCommits(
		_login: string,
		_token: string,
		windows: MonthWindow[],
	) {
		this.monthCalls += 1;
		this.fetchedChunks.push(windows.map((window) => window.label));
		if (this.monthCalls === this.failMonthCall) {
			throw new Error("GitHub unavailable");
		}
		return windows.map((_, index) => counts(index + 1));
	}

	async fetchRateLimitBudget() {
		return this.budget;
	}
}

function setup(store = new MemoryStore(), github = new FakeGitHub()) {
	return {
		store,
		github,
		run: createProfileIngestion({ store, github, chunkMonths: 2 }),
	};
}

function seedMonth(
	store: MemoryStore,
	entityId: string,
	month: string,
	commits: number,
	fetchedAt: Date | null = new Date("2026-05-01T00:00:00.000Z"),
) {
	const rows = store.months.get(entityId) ?? new Map();
	rows.set(month, {
		month,
		counts: counts(commits),
		fetchedAt,
	});
	store.months.set(entityId, rows);
}

describe("profile ingestion", () => {
	it("serves a fresh unique login-only profile without a GitHub call", async () => {
		const { run, store, github } = setup();
		const stored = await store.saveProfile(PROFILE);
		stored.builtAt = NOW;
		stored.lastFetched = NOW;
		for (const [index, month] of [
			"2026-01-01",
			"2026-02-01",
			"2026-03-01",
			"2026-04-01",
		].entries()) {
			seedMonth(store, stored.entityId, month, index + 1);
		}

		const result = await run(
			{ login: PROFILE.login },
			{ token: "token", now: NOW },
		);

		expect(result).toMatchObject({
			status: "complete",
			entityId: stored.entityId,
		});
		expect(github.profileCalls).toBe(0);
		expect(github.fetchedChunks).toEqual([]);
	});

	it("resolves a stale recycled login before reading its current owner's months", async () => {
		const { run, store } = setup();
		const previous = await store.saveProfile({
			...PROFILE,
			nodeId: "U_previous",
			name: "Previous owner",
		});
		previous.builtAt = new Date("2026-05-15T10:00:00.000Z");
		previous.lastFetched = new Date("2026-05-15T10:00:00.000Z");
		seedMonth(store, previous.entityId, "2026-01-01", 99);

		const result = await run(
			{ login: PROFILE.login },
			{ token: "token", now: NOW },
		);

		expect(result).toMatchObject({
			status: "complete",
			entityId: `github-user:${PROFILE.nodeId}`,
		});
		expect(result.status === "complete" && result.history.total).toBe(6);
		expect(
			store.months.get(previous.entityId)?.get("2026-01-01")?.counts.commits,
		).toBe(99);
	});

	it("builds a fresh profile and exposes it only after all completed months are durable", async () => {
		const { run, store, github } = setup();

		const result = await run(TARGET, { token: "token", now: NOW });

		expect(result).toMatchObject({
			status: "complete",
			login: "fresh",
			monthsStored: 4,
		});
		expect(github.fetchedChunks).toEqual([
			["2026-01-01", "2026-02-01"],
			["2026-03-01", "2026-04-01"],
		]);
		expect(store.completions).toHaveLength(1);
		expect(store.completions[0]).toMatchObject({
			total: 6,
			totalRestricted: 12,
			totalIssues: 18,
		});
	});

	it("resumes from durable completed months without refetching them", async () => {
		const { run, store, github } = setup();
		const stored = await store.saveProfile(PROFILE);
		seedMonth(store, stored.entityId, "2026-01-01", 7);
		seedMonth(store, stored.entityId, "2026-02-01", 8);

		const result = await run(TARGET, { token: "token", now: NOW });

		expect(result.status).toBe("complete");
		expect(github.fetchedChunks).toEqual([["2026-03-01", "2026-04-01"]]);
		expect(store.completions[0]?.total).toBe(18);
	});

	it("accepts legacy months when the completed build proves they were settled", async () => {
		const { run, store, github } = setup();
		const stored = await store.saveProfile(PROFILE);
		stored.builtAt = new Date("2026-05-01T00:00:00.000Z");
		stored.lastFetched = new Date("2026-05-01T00:00:00.000Z");
		for (const [index, month] of [
			"2026-01-01",
			"2026-02-01",
			"2026-03-01",
			"2026-04-01",
		].entries()) {
			seedMonth(store, stored.entityId, month, index + 1, null);
		}

		const result = await run(
			{ login: PROFILE.login },
			{ token: "token", now: NOW },
		);

		expect(result).toMatchObject({
			status: "complete",
			monthsStored: 4,
			history: { total: 10 },
		});
		expect(github.profileCalls).toBe(1);
		expect(github.fetchedChunks).toEqual([]);
		expect(store.completions).toHaveLength(1);
	});

	it("refetches a legacy month when the build finished before that month closed", async () => {
		const { run, store, github } = setup();
		const stored = await store.saveProfile(PROFILE);
		stored.builtAt = new Date("2026-01-20T00:00:00.000Z");
		stored.lastFetched = new Date("2026-01-20T00:00:00.000Z");
		seedMonth(store, stored.entityId, "2026-01-01", 99, null);
		seedMonth(store, stored.entityId, "2026-02-01", 2);

		await run(
			{ login: PROFILE.login },
			{ token: "token", now: new Date("2026-03-15T12:00:00.000Z") },
		);

		expect(github.fetchedChunks).toEqual([["2026-01-01"]]);
		expect(store.completions[0]?.total).toBe(3);
	});

	it("does not let build provenance override an explicit early fetch", async () => {
		const { run, store, github } = setup();
		const stored = await store.saveProfile(PROFILE);
		stored.builtAt = new Date("2026-05-01T00:00:00.000Z");
		stored.lastFetched = new Date("2026-05-01T00:00:00.000Z");
		seedMonth(
			store,
			stored.entityId,
			"2026-01-01",
			99,
			new Date("2026-01-20T00:00:00.000Z"),
		);
		seedMonth(store, stored.entityId, "2026-02-01", 2, null);
		seedMonth(store, stored.entityId, "2026-03-01", 3, null);
		seedMonth(store, stored.entityId, "2026-04-01", 4, null);

		await run({ login: PROFILE.login }, { token: "token", now: NOW });

		expect(github.fetchedChunks).toEqual([["2026-01-01"]]);
		expect(store.completions[0]?.total).toBe(10);
	});

	it("does not trust legacy provenance while the profile is incomplete", async () => {
		const { run, store, github } = setup();
		const stored = await store.saveProfile(PROFILE);
		seedMonth(store, stored.entityId, "2026-01-01", 99, null);
		seedMonth(store, stored.entityId, "2026-02-01", 2);

		await run(TARGET, {
			token: "token",
			now: new Date("2026-03-15T12:00:00.000Z"),
		});

		expect(github.fetchedChunks).toEqual([["2026-01-01"]]);
		expect(store.completions[0]?.total).toBe(3);
	});

	it("refetches an unproven month before marking the profile complete", async () => {
		const { run, store, github } = setup();
		const stored = await store.saveProfile(PROFILE);
		const rows = new Map<string, StoredProfileMonth>();
		rows.set("2026-01-01", {
			month: "2026-01-01",
			counts: counts(99),
			// This was fetched while January was still in progress, so it is not durable.
			fetchedAt: new Date("2026-01-20T00:00:00.000Z"),
		});
		store.months.set(stored.entityId, rows);

		await run(TARGET, { token: "token", now: new Date("2026-03-15") });

		expect(github.fetchedChunks).toEqual([["2026-01-01", "2026-02-01"]]);
		expect(store.completions).toHaveLength(1);
		expect(store.completions[0]?.total).toBe(3);
	});

	it("treats repeated delivery as idempotent and never rewrites completed months", async () => {
		const { run, store, github } = setup();
		await run(TARGET, { token: "token", now: NOW });
		github.fetchedChunks.length = 0;

		const second = await run(TARGET, { token: "token", now: NOW });

		expect(second.status).toBe("complete");
		expect(github.fetchedChunks).toEqual([]);
		expect(store.months.values().next().value?.size).toBe(4);
	});

	it("keeps completed chunks resumable and withholds completion after a mid-build failure", async () => {
		const { run, store, github } = setup();
		github.failMonthCall = 2;

		await expect(run(TARGET, { token: "token", now: NOW })).rejects.toThrow(
			"GitHub unavailable",
		);

		expect([...(store.months.values().next().value?.keys() ?? [])]).toEqual([
			"2026-01-01",
			"2026-02-01",
		]);
		expect(store.completions).toHaveLength(0);
	});

	it("serves a completed history when refreshing a new tail month fails", async () => {
		const { run, store, github } = setup();
		const stored = await store.saveProfile(PROFILE);
		stored.builtAt = new Date("2026-04-01T00:00:00.000Z");
		stored.lastFetched = new Date("2026-04-01T00:00:00.000Z");
		for (const [index, month] of [
			"2026-01-01",
			"2026-02-01",
			"2026-03-01",
		].entries()) {
			seedMonth(store, stored.entityId, month, index + 1);
		}
		github.failMonthCall = 1;

		const result = await run(TARGET, { token: "token", now: NOW });

		expect(result).toMatchObject({
			status: "complete",
			monthsStored: 3,
			history: { total: 6 },
		});
		expect(store.completions).toHaveLength(0);
	});

	it("stops at the caller's runtime budget and reports durable progress", async () => {
		const store = new MemoryStore();
		const github = new FakeGitHub();
		let clock = 0;
		const run = createProfileIngestion({
			store,
			github,
			chunkMonths: 2,
			timeMs: () => clock++ * 10,
		});

		const result = await run(TARGET, {
			token: "token",
			now: NOW,
			maxRuntimeMs: 5,
		});

		expect(result).toMatchObject({
			status: "paused",
			progress: { monthsFetched: 2, monthsTotal: 4 },
		});
		expect(store.completions).toHaveLength(0);
	});

	it("stops a worker between durable chunks when its signal is aborted", async () => {
		const { run, store, github } = setup();
		const controller = new AbortController();
		const fetchMonthlyCommits = github.fetchMonthlyCommits.bind(github);
		github.fetchMonthlyCommits = async (...args) => {
			const result = await fetchMonthlyCommits(...args);
			controller.abort();
			return result;
		};

		await expect(
			run(TARGET, { token: "token", now: NOW, signal: controller.signal }),
		).rejects.toThrow();

		expect([...(store.months.values().next().value?.keys() ?? [])]).toEqual([
			"2026-01-01",
			"2026-02-01",
		]);
		expect(store.completions).toHaveLength(0);
	});

	it("defers before profile or month work when the shared quota reaches its floor", async () => {
		const { run, store, github } = setup();
		github.budget = {
			remaining: 500,
			resetAt: "2026-05-15T13:00:00.000Z",
		};

		const result = await run(TARGET, {
			token: "token",
			now: NOW,
			remainingFloor: 500,
		});

		expect(result).toEqual({
			status: "deferred",
			retryAt: new Date("2026-05-15T13:00:00.000Z"),
		});
		expect(store.profiles.size).toBe(0);
		expect(github.fetchedChunks).toEqual([]);
	});

	it("follows an immutable identity through a rename and preserves its durable months", async () => {
		const { run, store, github } = setup();
		const original = await store.saveProfile({
			...PROFILE,
			login: "old-login",
		});
		seedMonth(store, original.entityId, "2026-01-01", 9);
		github.profile = { ...PROFILE, login: "new-login" };

		const result = await run(
			{ login: "old-login", githubNodeId: PROFILE.nodeId },
			{ token: "token", now: new Date("2026-02-15T12:00:00.000Z") },
		);

		expect(result).toMatchObject({
			status: "complete",
			entityId: original.entityId,
			login: "new-login",
		});
		expect(store.profiles.get(original.entityId)?.profile.login).toBe(
			"new-login",
		);
		expect(
			store.months.get(original.entityId)?.get("2026-01-01")?.counts,
		).toEqual(counts(9));
		expect(github.fetchedChunks).toEqual([]);
	});
});
