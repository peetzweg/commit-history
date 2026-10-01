import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProfile, fetchRateLimitBudget } from "#/lib/github";
import { fetchFollowing } from "#/lib/github-following";
import { createBudgetGuard } from "#/lib/job-runner";
import {
	type GitHubCallRecord,
	type GitHubSource,
	outcomeForHttpStatus,
	parseRateLimitHeaders,
	recordGitHubCall,
	setTelemetryBackend,
	withGitHubSource,
} from "#/lib/telemetry";

const RESET = 1_790_000_000;

function rateLimitHeaders(
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		"x-ratelimit-resource": "graphql",
		"x-ratelimit-limit": "5000",
		"x-ratelimit-remaining": "4990",
		"x-ratelimit-used": "10",
		"x-ratelimit-reset": String(RESET),
		...overrides,
	};
}

/** Captures records the way the OTel backend does, including the ambient source. */
function captureBackend() {
	const calls: Array<GitHubCallRecord & { source: GitHubSource | undefined }> =
		[];
	const source = new AsyncLocalStorage<GitHubSource>();
	setTelemetryBackend({
		recordGitHubCall: (record) =>
			calls.push({ ...record, source: source.getStore() }),
		runWithSource: (value, fn) => source.run(value, fn),
	});
	return calls;
}

afterEach(() => {
	setTelemetryBackend(null);
	vi.unstubAllGlobals();
});

describe("parseRateLimitHeaders", () => {
	it("reads GitHub's primary-limit headers", () => {
		expect(parseRateLimitHeaders(new Headers(rateLimitHeaders()))).toEqual({
			resource: "graphql",
			limit: 5000,
			remaining: 4990,
			used: 10,
			resetAtMs: RESET * 1000,
		});
	});

	it("returns null when a header is missing or malformed", () => {
		const missing = rateLimitHeaders();
		delete missing["x-ratelimit-remaining"];
		expect(parseRateLimitHeaders(new Headers(missing))).toBeNull();
		expect(
			parseRateLimitHeaders(
				new Headers(rateLimitHeaders({ "x-ratelimit-used": "lots" })),
			),
		).toBeNull();
	});
});

describe("outcomeForHttpStatus", () => {
	const window = (remaining: number) =>
		parseRateLimitHeaders(
			new Headers(
				rateLimitHeaders({ "x-ratelimit-remaining": String(remaining) }),
			),
		);

	it("tells the primary limit from the secondary limit", () => {
		expect(outcomeForHttpStatus(403, window(0), null)).toBe("rate_limited");
		expect(outcomeForHttpStatus(403, window(1200), "60")).toBe(
			"secondary_rate_limited",
		);
		expect(outcomeForHttpStatus(429, window(1200), null)).toBe(
			"secondary_rate_limited",
		);
		expect(outcomeForHttpStatus(403, window(1200), null)).toBe("client_error");
	});

	it("maps the remaining statuses", () => {
		expect(outcomeForHttpStatus(401, null, null)).toBe("unauthorized");
		expect(outcomeForHttpStatus(404, null, null)).toBe("not_found");
		expect(outcomeForHttpStatus(502, null, null)).toBe("server_error");
		expect(outcomeForHttpStatus(422, null, null)).toBe("client_error");
	});
});

describe("facade without a backend", () => {
	it("is a no-op", () => {
		expect(withGitHubSource("live", () => 42)).toBe(42);
		expect(() =>
			recordGitHubCall({
				api: "graphql",
				operation: "fetchProfile",
				outcome: "ok",
				durationMs: 1,
				rateLimit: null,
			}),
		).not.toThrow();
	});

	it("swallows backend failures", () => {
		setTelemetryBackend({
			recordGitHubCall: () => {
				throw new Error("exporter exploded");
			},
			runWithSource: (_source, fn) => fn(),
		});
		expect(() =>
			recordGitHubCall({
				api: "rest",
				operation: "fetchFollowing",
				outcome: "ok",
				durationMs: 1,
				rateLimit: null,
			}),
		).not.toThrow();
	});
});

describe("GitHub client instrumentation", () => {
	it("records each GraphQL attempt with its operation, outcome and budget", async () => {
		const calls = captureBackend();
		let attempt = 0;
		vi.stubGlobal("fetch", async () => {
			attempt += 1;
			if (attempt === 1) {
				return new Response("bad gateway", {
					status: 502,
					headers: rateLimitHeaders({ "x-ratelimit-remaining": "4991" }),
				});
			}
			return new Response(
				JSON.stringify({
					data: {
						user: {
							id: "U_1",
							login: "octocat",
							name: null,
							avatarUrl: "",
							createdAt: "2011-01-25T18:44:36Z",
							bio: null,
							company: null,
							location: null,
							websiteUrl: null,
							twitterUsername: null,
							followers: { totalCount: 1 },
							following: { totalCount: 1 },
							repositories: { totalCount: 1 },
						},
					},
				}),
				{ headers: rateLimitHeaders() },
			);
		});

		await withGitHubSource("live", () => fetchProfile("octocat", "tok"));

		expect(calls.map((c) => [c.source, c.api, c.operation, c.outcome])).toEqual(
			[
				["live", "graphql", "fetchProfile", "server_error"],
				["live", "graphql", "fetchProfile", "ok"],
			],
		);
		expect(calls[1].rateLimit?.remaining).toBe(4990);
	});

	it("maps GraphQL RATE_LIMITED errors on HTTP 200 to rate_limited", async () => {
		const calls = captureBackend();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						errors: [{ type: "RATE_LIMITED", message: "slow down" }],
					}),
					{ headers: rateLimitHeaders({ "x-ratelimit-remaining": "0" }) },
				),
		);

		expect(await fetchRateLimitBudget("tok")).toBeNull();
		expect(calls.map((c) => [c.operation, c.outcome])).toEqual([
			["fetchRateLimitBudget", "rate_limited"],
		]);
	});

	it("records network failures before rethrowing them", async () => {
		const calls = captureBackend();
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("fetch failed");
		});

		await expect(fetchProfile("octocat", "tok")).rejects.toThrow(
			"fetch failed",
		);
		expect(calls.map((c) => c.outcome)).toEqual(["network_error"]);
	});

	it("records every REST following page against the core budget", async () => {
		const calls = captureBackend();
		const row = (i: number) => ({
			login: `user${i}`,
			node_id: `U_${i}`,
			type: "User",
		});
		let page = 0;
		vi.stubGlobal("fetch", async () => {
			page += 1;
			const rows =
				page === 1 ? Array.from({ length: 100 }, (_, i) => row(i)) : [row(100)];
			return new Response(JSON.stringify(rows), {
				headers: rateLimitHeaders({
					"x-ratelimit-resource": "core",
					"x-ratelimit-remaining": String(4000 - page),
				}),
			});
		});

		await withGitHubSource("network-discovery", () =>
			fetchFollowing("octocat", "tok"),
		);

		expect(
			calls.map((c) => [c.source, c.api, c.operation, c.rateLimit?.resource]),
		).toEqual([
			["network-discovery", "rest", "fetchFollowing", "core"],
			["network-discovery", "rest", "fetchFollowing", "core"],
		]);
	});
});

describe("budget guard probe accounting", () => {
	it("counts the rate-limit probe's reported cost in the run's spend", async () => {
		const guard = createBudgetGuard({
			label: "test",
			remainingFloor: 100,
			pollEvery: 10,
			fetchRateLimit: async () => ({
				remaining: 4000,
				resetAt: new Date(RESET * 1000).toISOString(),
				cost: 1,
			}),
			sleep: async () => {},
			nowMs: () => 0,
			runtimeLeftMs: () => 60_000,
			logger: { info: () => {}, warn: () => {}, error: () => {} },
		});

		expect(await guard.ensure()).toBe(true);
		guard.spend(3);
		expect(guard.spent()).toBe(4);
	});
});
