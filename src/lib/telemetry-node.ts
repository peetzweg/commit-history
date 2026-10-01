/**
 * OpenTelemetry metrics backend for the `telemetry.ts` facade (#202). NODE-ONLY: import it only
 * from Node entrypoints (the Nitro plugin and `scripts/`), never from a route or a module a route
 * imports, or `node:async_hooks` and the SDK end up in the browser bundle.
 *
 * Export is opt-in. Without `OTEL_EXPORTER_OTLP_ENDPOINT` (or the metrics-specific variant),
 * `startTelemetry` installs nothing and the facade stays a no-op, which keeps local development
 * and tests free of any telemetry setup. The exporter reads the standard `OTEL_EXPORTER_OTLP_*`
 * variables itself (endpoint, headers), so the Grafana Cloud credentials live only in env.
 *
 * Environments are told apart by `service.namespace` (default `production`), which Prometheus
 * turns into the `job` label as `<namespace>/<service.name>`. Previews set
 * `OTEL_RESOURCE_ATTRIBUTES=service.namespace=preview`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Attributes, Meter } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import {
	detectResources,
	envDetector,
	resourceFromAttributes,
} from "@opentelemetry/resources";
import {
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	type GitHubCallRecord,
	type GitHubSource,
	type RateLimitSnapshot,
	setTelemetryBackend,
	telemetryConfigured,
} from "#/lib/telemetry";

export interface TelemetryHandle {
	/** Null when export is disabled; callers skip their own instruments then. */
	meter: Meter | null;
	/** Flush pending metrics and stop. Bounded and never throws, so it is safe in any teardown. */
	shutdown(): Promise<void>;
}

const DISABLED: TelemetryHandle = { meter: null, shutdown: async () => {} };
const SHUTDOWN_TIMEOUT_MS = 5_000;
// GitHub calls range from ~100ms profile reads to ~10s contribution batches near the timeout.
const DURATION_BUCKETS_S = [0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30];

export function startTelemetry(opts: {
	serviceName: string;
	defaultSource: GitHubSource;
	env?: NodeJS.ProcessEnv;
}): TelemetryHandle {
	const env = opts.env ?? process.env;
	if (!telemetryConfigured(env)) return DISABLED;

	const resource = resourceFromAttributes({
		"service.name": opts.serviceName,
		"service.namespace": "production",
		// Distinct per process, so overlapping deploys or job runs never write the same series.
		"service.instance.id": randomUUID(),
	}).merge(detectResources({ detectors: [envDetector] }));

	const exportIntervalMillis =
		Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 60_000;
	const provider = new MeterProvider({
		resource,
		readers: [
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter(),
				exportIntervalMillis,
			}),
		],
	});
	const meter = provider.getMeter("commit-history");

	const requests = meter.createCounter("github.requests", {
		description: "GitHub API requests, one per attempt (retries included).",
	});
	const duration = meter.createHistogram("github.request.duration", {
		description: "GitHub API request duration.",
		unit: "s",
		advice: { explicitBucketBoundaries: DURATION_BUCKETS_S },
	});

	// Latest primary window per budget (`graphql`, `core`). Within one window keep the lowest
	// remaining, because concurrent responses can arrive out of order.
	const windows = new Map<string, RateLimitSnapshot>();
	const observeWindow = (next: RateLimitSnapshot) => {
		const current = windows.get(next.resource);
		if (
			!current ||
			next.resetAtMs > current.resetAtMs ||
			(next.resetAtMs === current.resetAtMs &&
				next.remaining < current.remaining)
		) {
			windows.set(next.resource, next);
		}
	};
	const budgetGauge = (
		name: string,
		description: string,
		pick: (w: RateLimitSnapshot) => number,
	) =>
		meter.createObservableGauge(name, { description }).addCallback((result) => {
			const now = Date.now();
			for (const w of windows.values()) {
				// A window past its reset is stale: the budget is full again, and whoever calls
				// GitHub next reports the fresh numbers.
				if (w.resetAtMs > now)
					result.observe(pick(w), { resource: w.resource });
			}
		});
	budgetGauge(
		"github.ratelimit.remaining",
		"Primary rate-limit points left in the current window.",
		(w) => w.remaining,
	);
	budgetGauge(
		"github.ratelimit.limit",
		"Primary rate-limit points per window.",
		(w) => w.limit,
	);
	budgetGauge(
		"github.ratelimit.used",
		"Primary rate-limit points used in the current window.",
		(w) => w.used,
	);
	budgetGauge(
		"github.ratelimit.reset",
		"Unix time (seconds) when the current window resets.",
		(w) => Math.floor(w.resetAtMs / 1000),
	);

	const sourceContext = new AsyncLocalStorage<GitHubSource>();
	setTelemetryBackend({
		recordGitHubCall(record: GitHubCallRecord) {
			const attributes: Attributes = {
				source: sourceContext.getStore() ?? opts.defaultSource,
				operation: record.operation,
				api: record.api,
				outcome: record.outcome,
			};
			requests.add(1, attributes);
			duration.record(record.durationMs / 1000, attributes);
			if (record.rateLimit) observeWindow(record.rateLimit);
		},
		runWithSource(source, fn) {
			return sourceContext.run(source, fn);
		},
	});

	let stopped: Promise<void> | undefined;
	return {
		meter,
		shutdown() {
			stopped ??= (async () => {
				setTelemetryBackend(null);
				await Promise.race([
					provider.shutdown(),
					new Promise((resolve) =>
						setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref(),
					),
				]).catch(() => {});
			})();
			return stopped;
		},
	};
}
