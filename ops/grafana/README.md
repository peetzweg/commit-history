# Observability (Grafana Cloud)

The web server, the profile worker and the scheduled jobs push OpenTelemetry metrics over OTLP.
Export is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so local development and tests need
nothing. See #202.

## Setup

1. Create a Grafana Cloud stack (free tier), then open **Connections → OpenTelemetry (OTLP)** and
   generate a token. It shows the two values below.
2. Set them on each Coolify application that should report (web app, profile worker; scheduled
   tasks inherit the web app's env):

   ```
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<zone>.grafana.net/otlp
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64 of instanceId:token>
   ```

   For PR previews, also set `OTEL_RESOURCE_ATTRIBUTES=service.namespace=preview` so preview
   traffic stays apart from production (the default namespace is `production`).
3. Import `commit-history-operations.json` via **Dashboards → New → Import** and pick the
   `grafanacloud-…-prom` data source.

`OTEL_METRIC_EXPORT_INTERVAL` (ms, default 60000) can be lowered temporarily while testing.

## What is exported

Every series carries `job="<namespace>/<service>"`, where the service is `commit-history-web`,
`commit-history-worker`, `commit-history-monthly-user-refresh` or `commit-history-refresh-orgs`.

| Prometheus name | Type | Labels |
|---|---|---|
| `github_requests_total` | counter, one per HTTP attempt (retries included) | `source`, `operation`, `api`, `outcome` |
| `github_request_duration_seconds` | histogram | same |
| `github_ratelimit_remaining` / `_limit` / `_used` / `_reset` | gauge, from GitHub's response headers | `resource` (`graphql`, `core`) |
| `queue_jobs` | gauge (worker) | `queue`, `state` (`ready`, `deferred`, `retry`, `active`, `failed`) |
| `queue_oldest_ready_age_seconds` | gauge (worker) | `queue` |
| `queue_job_duration_seconds` | histogram (worker) | `queue`, `outcome` |
| `worker_up` | gauge, 1 while the worker runs | |

`source` is one of `live`, `profile-worker`, `network-discovery`, `monthly-user-refresh`,
`organization-refresh`. `operation` is the GitHub client function (`fetchProfile`,
`fetchMonthlyCommits`, `fetchRateLimitBudget`, …), so live profile and live organization traffic
are told apart by operation. No label ever carries a login, node ID, job ID, token or URL.

Request counts are the attribution. GitHub does not report a per-query point cost in headers, so
points spent per flow are approximated by request counts; the budget gauges show the token's true
total.

pg-boss additionally keeps its own queue-depth snapshots and backlog warnings in
`pgboss.queue_stats` / `pgboss.warning` for 14 days.

## Alerts

Create these as Grafana-managed alert rules (**Alerting → Alert rules → New**) and route them to
a contact point (email or the Grafana mobile app). Replace `production` to cover previews.

| Alert | Query | Condition |
|---|---|---|
| GraphQL budget runs out before reset | `min(github_ratelimit_remaining{resource="graphql",job=~"production/.*"}) - clamp_min(deriv(max(github_ratelimit_used{resource="graphql",job=~"production/.*"})[10m:1m]), 0) * (min(github_ratelimit_reset{resource="graphql",job=~"production/.*"}) - time())` | `< 500` for 5m |
| Worker heartbeat missing | `max(worker_up{job="production/commit-history-worker"})` | no data for 10m (set "Alert state if no data" to **Alerting**) |
| Old ready job | `max(queue_oldest_ready_age_seconds{queue="profile-ingestion-v1",job=~"production/.*"})` | `> 7200` for 15m |
| Dead-letter or failed work retained | `sum(max by (queue, state) (queue_jobs{job=~"production/.*",state=~"ready|deferred|failed",queue=~".*-dead-v1"}))` | `> 0` for 30m |

## Smoke procedure

After deploying with the env vars set:

1. Open a profile that is already cached (for example your own) once.
2. Enqueue one controlled ingestion job: `node .output/worker/enqueue-profile-ingestion.mjs <login>`
   inside the app container.
3. In **Explore**, within two minutes:
   - `sum by (source, operation, outcome) (increase(github_requests_total[10m]))` shows `live` rows
     from step 1 (a cache hit may make only a refresh call, or none) and `profile-worker` rows
     from step 2.
   - `github_ratelimit_remaining` shows both `graphql` and, after network discovery, `core`.
   - `queue_job_duration_seconds_count{queue="profile-ingestion-v1"}` went up by one.
   - `worker_up` is 1.

Nothing in these queries needs credentials beyond the Grafana login, and no label shows a login.
