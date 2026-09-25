/**
 * Operational telemetry facade (#202). Client-safe on purpose: `github.ts` is imported by route
 * files, so this module must stay free of Node-only APIs and of the OpenTelemetry SDK. Every
 * function is a no-op until a Node entrypoint installs a backend (`startTelemetry` in
 * `telemetry-node.ts`), which only happens when an OTLP endpoint is configured.
 *
 * Labels are a closed vocabulary. Never add a login, node ID, job ID, token or URL here: each
 * distinct label value is a separate time series, and those values are both unbounded and private.
 */

/** Which application flow spent the shared GitHub token. */
export type GitHubSource =
	| "live"
	| "profile-worker"
	| "network-discovery"
	| "monthly-user-refresh"
	| "organization-refresh";

/** The GitHub client call that made the request. */
export type GitHubOperation =
	| "fetchRateLimitBudget"
	| "fetchProfile"
	| "fetchProfileByNodeId"
	| "fetchOrgProfile"
	| "fetchOrgMembers"
	| "fetchOrgMemberContributions"
	| "fetchMonthlyCommits"
	| "fetchFollowing";

export type GitHubOutcome =
	| "ok"
	| "not_found"
	| "rate_limited"
	| "secondary_rate_limited"
	| "unauthorized"
	| "client_error"
	| "server_error"
	| "graphql_error"
	| "malformed"
	| "network_error";

/** GitHub's primary rate-limit window, as returned on every REST and GraphQL response. */
export interface RateLimitSnapshot {
	/** `graphql` or `core` (REST). Each has its own hourly budget. */
	resource: string;
	limit: number;
	remaining: number;
	used: number;
	resetAtMs: number;
}

export interface GitHubCallRecord {
	api: "graphql" | "rest";
	operation: GitHubOperation;
	outcome: GitHubOutcome;
	durationMs: number;
	rateLimit: RateLimitSnapshot | null;
}

export interface TelemetryBackend {
	recordGitHubCall(record: GitHubCallRecord): void;
	runWithSource<T>(source: GitHubSource, fn: () => T): T;
}

// Kept on globalThis: in dev, Vite's SSR runner and the Nitro plugin can each load their own copy
// of this module, and both must see the backend the plugin installed.
const BACKEND_KEY = Symbol.for("commit-history.telemetry.backend");
type BackendHolder = { [BACKEND_KEY]?: TelemetryBackend };

export function setTelemetryBackend(backend: TelemetryBackend | null): void {
	(globalThis as BackendHolder)[BACKEND_KEY] = backend ?? undefined;
}

function backend(): TelemetryBackend | undefined {
	return (globalThis as BackendHolder)[BACKEND_KEY];
}

/** Record one GitHub HTTP request. Telemetry must never break the request it observes. */
export function recordGitHubCall(record: GitHubCallRecord): void {
	try {
		backend()?.recordGitHubCall(record);
	} catch {
		// Best-effort by design.
	}
}

/** Attribute every GitHub request made inside `fn` (including async continuations) to `source`. */
export function withGitHubSource<T>(source: GitHubSource, fn: () => T): T {
	const active = backend();
	return active ? active.runWithSource(source, fn) : fn();
}

/** Whether OTLP export is configured. Everything telemetry-related is skipped when it is not. */
export function telemetryConfigured(
	env: Record<string, string | undefined>,
): boolean {
	return Boolean(
		env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
	);
}

/** Parse GitHub's `x-ratelimit-*` headers. Null when any value is missing or malformed. */
export function parseRateLimitHeaders(
	headers: Headers,
): RateLimitSnapshot | null {
	const resource = headers.get("x-ratelimit-resource");
	const limit = Number(headers.get("x-ratelimit-limit"));
	const remaining = Number(headers.get("x-ratelimit-remaining"));
	const used = Number(headers.get("x-ratelimit-used"));
	const reset = Number(headers.get("x-ratelimit-reset"));
	if (
		!resource ||
		!headers.has("x-ratelimit-remaining") ||
		![limit, remaining, used, reset].every(Number.isFinite)
	) {
		return null;
	}
	return { resource, limit, remaining, used, resetAtMs: reset * 1000 };
}

/**
 * Classify a non-2xx HTTP status. GitHub signals its secondary limit with a 403/429 while primary
 * budget remains; a primary-limit hit has `remaining` at zero.
 */
export function outcomeForHttpStatus(
	status: number,
	rateLimit: RateLimitSnapshot | null,
	retryAfter: string | null,
): GitHubOutcome {
	if (status === 401) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 403 || status === 429) {
		if (rateLimit?.remaining === 0) return "rate_limited";
		if (retryAfter != null || status === 429) return "secondary_rate_limited";
		return "client_error";
	}
	if (status >= 500) return "server_error";
	return "client_error";
}
