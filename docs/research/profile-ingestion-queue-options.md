# Profile-ingestion queue options for Postgres and Coolify

Research date: 2026-08-28  
Wayfinder ticket: [Research profile-ingestion queue options for Postgres and Coolify](https://github.com/peetzweg/commit-history/issues/182)

## Answer

Use **Graphile Worker** for the first reusable profile-ingestion queue, unless the architecture decision establishes that a job abandoned by a dead worker must be detected and retried in minutes rather than hours. It is the narrowest maintained option that supplies durable at-least-once execution, concurrent claiming, delayed retries, deduplication, schema migrations, and graceful signal handling while staying inside the existing Node/Postgres deployment.

Use **pg-boss** instead if configurable job expiration, heartbeats, dead-letter queues, retained job history, or richer operational controls are requirements for the first release. It covers more failure modes out of the box, but introduces a larger policy surface and a less direct integration with the repository's current `drizzle-orm/postgres-js` connection than Graphile Worker's public SQL enqueue function.

Do **not** begin with a bespoke queue merely because `FOR UPDATE SKIP LOCKED` makes claiming a row concise. A correct first version would also have to define and test leases, abandoned-job recovery, retry scheduling, terminal failure, cleanup, shutdown races, concurrency, and visibility. That work is justified only if owning queue state in the application schema is itself a product requirement.

This recommendation is an inference from the facts below, not a benchmark result. The expected workload is API-bound and modest; all three options have far more raw Postgres capacity than this feature is likely to need.

## Current constraints

Facts from the repository at [`ce79f18`](https://github.com/peetzweg/commit-history/tree/ce79f18bb99d905df49ee7c749452ca12fb13112):

- The project is Node 24, TypeScript/ESM, TanStack Start, Drizzle, `postgres.js`, and Postgres. The database client disables prepared statements because the same code can run through a transaction-pooled PgBouncer endpoint ([database client](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/src/lib/db/index.ts#L19-L31)). This does not prove production currently uses transaction pooling; it means a queue connection must not assume otherwise without checking the deployed `DATABASE_URL`.
- `pnpm build` already bundles two Node worker entrypoints with esbuild into `.output/worker/*.mjs` ([package scripts](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/package.json#L11-L14)). The runtime image copies only `.output`, not sources or `node_modules`, and starts the web server by default ([Dockerfile](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/Dockerfile#L10-L19)). A new queue library therefore has to be included in a bundled worker entrypoint, or the runtime-image strategy has to change.
- Coolify currently invokes the bundled workers as scheduled tasks from the application image rather than running a separate worker service ([deployment documentation](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/README.md#L109-L156)). An on-demand backlog needs an always-running process, not another monthly schedule.
- Existing background plumbing already supplies process-wide advisory locks, a shared GitHub GraphQL quota floor, bounded runtime, and explicit pool shutdown ([job runner](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/src/lib/job-runner.ts#L1-L12), [quota guard](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/src/lib/job-runner.ts#L113-L195), [worker shutdown](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/scripts/monthly-user-refresh.ts#L75-L93)). Those primitives remain useful inside a queue handler, but they are not a durable queue.
- Current jobs resume from application data: for example, the monthly worker treats an incomplete month row as the retry queue and serializes the whole run with one advisory lock ([monthly refresh store](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/src/lib/monthly-user-refresh-store.ts#L19-L72)). That is appropriate for periodic scans, but not for immediate, independently prioritized profile requests.

## Comparison

| Concern | Bespoke Postgres queue | Graphile Worker | pg-boss |
| --- | --- | --- | --- |
| Durability and delivery | Application owns transactions and recovery; can provide at-least-once execution | Postgres-backed, documented at-least-once execution; success normally removes the job | Postgres-backed atomic claiming; package advertises exactly-once job delivery, but handlers still need idempotency for external/API side effects |
| Deduplication | Exact desired semantics via a unique/partial index and `ON CONFLICT`; application must specify lifecycle details | `jobKey` supports replace/debounce/throttle; a new job is created if the matching one is locked unless `unsafe_dedupe` is used | Queue policies plus `singletonKey`, throttling/debouncing, and `upsert`; more expressive and more choices to configure correctly |
| Leasing and dead workers | Fully tunable, but lease acquisition, renewal, expiry, fencing, and stale completion are application code | Graceful shutdown is built in; an ungraceful process death leaves jobs locked for at least four hours before automatic recovery | Per-job expiration plus optional automatic heartbeats can detect dead workers on a chosen timescale |
| Retries/backoff | Fully tunable; application owns scheduling and terminal failure | Automatic fixed exponential-backoff formula; default 25 attempts; attempt count configurable | Fixed or exponential backoff with delay/cap, retry limits, expiration, heartbeat, and optional dead-letter queue |
| Concurrency | `FOR UPDATE SKIP LOCKED` is the standard primitive; application owns worker pool and fairness | Worker concurrency and named serial queues built in | Local concurrency, batch processing, queue policies, and per-group local/global controls built in |
| Graceful shutdown | Application owns signal handling, stop-claiming, abort, and lease-release behavior | SIGTERM/SIGINT stop new work and wait for active jobs; a second signal force-fails/unlocks jobs | `stop()` and `offWork()` can wait for active handlers; application must wire process signals and wait for the stopped lifecycle correctly |
| Schema ownership | Application schema and Drizzle migrations; easiest to query and evolve with product state | Library owns a separate schema and migrations; private tables are explicitly not API, so application-visible progress should live in application tables | Library owns a separate schema and can auto-migrate or run migrations explicitly; more retained queue state and maintenance behavior |
| PgBouncer transaction mode | Works if all operations are ordinary transactions/polling; session advisory locks and `LISTEN` do not | Default `LISTEN/NOTIFY` is not compatible with transaction pooling; use a direct/session connection for the worker | Polling works through transaction pooling; optional `LISTEN/NOTIFY` detects incompatibility and falls back to polling |
| Operational burden | Highest code/test burden; lowest dependency burden | Smallest feature/configuration surface of the maintained choices | More features, configuration, maintenance jobs, and optional monitoring surface |
| Fit with current image | One more local bundle | ESM package supports current Node; one more bundled entrypoint | ESM package supports current Node; one more bundled entrypoint, plus its `pg` pool unless a compatible adapter is chosen |

## Option details

### Bespoke Postgres queue

Postgres provides the essential primitives. Its documentation explicitly calls `SKIP LOCKED` unsuitable for general-purpose reads but useful for avoiding contention among multiple consumers of a queue-like table ([`SELECT`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)). `INSERT ... ON CONFLICT DO UPDATE` guarantees an atomic insert-or-update outcome under concurrency, so a unique job identity can coalesce enqueue requests ([`INSERT`](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)).

A plausible application-owned row would need, at minimum, job type, entity identity, payload/version, priority, state, `run_at`, attempt/max-attempt counts, lease owner/expiry, last error, and timestamps. Claiming would atomically select eligible rows with `FOR UPDATE SKIP LOCKED` and update their lease. A partial unique index could enforce one pending/running profile-ingestion job per immutable GitHub identity.

Everything after that sentence is application policy, not supplied by Postgres:

- whether an enqueue during active work is discarded, updates the active intent, or creates one follow-up run;
- how and when leases are renewed;
- how a stale worker is prevented from committing after its lease has been reassigned (a fencing/version check);
- which failures retry, the delay formula, terminal failure state, and manual redrive;
- when completed and failed rows are pruned;
- how shutdown stops claims, aborts I/O, and either finishes or relinquishes work;
- what operators can inspect, alert on, retry, or cancel.

Inference: this is viable for one idempotent ingestion job at low volume, especially because the repository already has strong testable worker abstractions. It is not the lowest-risk route to the reusable primitive described by the map, because correctness and operations become local maintenance work immediately.

### Graphile Worker

Graphile Worker documents Postgres transactional durability, at-least-once execution, `SKIP LOCKED` claiming, `LISTEN/NOTIFY`, parallel workers, named serial queues, exponential retry, and `job_key` deduplication ([introduction](https://worker.graphile.org/docs/)). Concurrency defaults to one per process and is configurable, while its pool defaults to ten connections and must have at least two ([configuration](https://worker.graphile.org/docs/config#workerconcurrentjobs), [pool sizing](https://worker.graphile.org/docs/config#workermaxpoolsize)). That is a sensible starting shape for a shared GitHub token: one concurrent profile ingestion and a deliberately small database pool.

`jobKey` needs a deliberate semantic choice. In the default `replace` mode, or `preserve_run_at`, an unlocked matching job is updated; if it is already locked/running, its key is cleared and a new job is scheduled. `unsafe_dedupe` also suppresses a new job when the old job is running or permanently failed, and the project explicitly warns that this can lose the action that caused the enqueue ([job-key behavior and caveats](https://worker.graphile.org/docs/job-key)). For profile ingestion, the safe inference is a key such as `profile-ingest:<immutable-github-id>` with `preserve_run_at`: bursts coalesce before execution, while an enqueue that arrives during execution leaves one follow-up run rather than losing intent. Handlers and writes must remain idempotent because at-least-once execution is the contract.

Thrown task errors retry automatically on a fixed exponential schedule; the default is 25 attempts, and `maxAttempts` can be set per job ([add-job API](https://worker.graphile.org/docs/library/add-job), [backoff schedule](https://worker.graphile.org/docs/exponential-backoff)). This is less configurable than pg-boss. GitHub quota exhaustion should not be represented as repeated generic failures: inference suggests the handler should use the existing quota guard and deliberately defer/reschedule work at the reset time.

Graceful SIGTERM/SIGINT stops claims and waits for active tasks; a subsequent signal force-fails/unlocks them ([error handling](https://worker.graphile.org/docs/error-handling)). The material limitation is catastrophic exit: a job held by a killed or crashed process stays locked for at least four hours before the periodic reset makes it runnable again. The scan interval is configurable, but the documented lock-age threshold is four hours ([error handling](https://worker.graphile.org/docs/error-handling#instantaneous-exit), [reset scan configuration](https://worker.graphile.org/docs/config#workerminresetlockedinterval)). This is probably acceptable for rare OOM/SIGKILL events if Coolify normally deploys with SIGTERM; it is the principal reason to choose pg-boss instead if quick crash recovery is a requirement.

Graphile Worker owns and migrates a separate `graphile_worker` schema. Its private tables may change even in minor versions; consumers should use public functions and views. The documentation recommends an application-owned "shadow" row for user-visible progress because successful jobs are deleted ([schema contract](https://worker.graphile.org/docs/schema), [job-key completion behavior](https://worker.graphile.org/docs/job-key#job-key-caveats)). That separation fits this project: queue mechanics remain library-owned, while the public leaderboard can derive readiness from application-owned ingestion/profile state.

The web app can enqueue through the supported `graphile_worker.add_job(...)` SQL function from the same Drizzle transaction that records a relationship or ingestion request ([adding jobs through SQL](https://worker.graphile.org/docs/sql-add-job)). This avoids coupling web requests to Graphile's own `pg.Pool`; the continuous worker can use its own small pool.

Connection topology must be verified before adoption. Graphile's default `LISTEN/NOTIFY` behavior is incompatible with PgBouncer transaction mode, and its FAQ does not offer a polling-only switch ([Graphile Worker FAQ](https://worker.graphile.org/docs/faq#is-listennotify-used-by-default-and-will-this-pose-a-problem-for-pgbouncer)). The worker should therefore use a direct/session Postgres URL. Disabling prepared statements alone only addresses prepared-statement compatibility, not `LISTEN` session affinity ([runner options](https://worker.graphile.org/docs/library/run#runneroptions)).

### pg-boss

pg-boss is also Postgres-native and uses `SKIP LOCKED`. It advertises exactly-once job delivery and atomic commits ([project documentation](https://pgboss.io/)). That phrase describes queue delivery/claiming, not an end-to-end guarantee for GitHub calls and application writes. Inference: profile-ingestion handlers must still be idempotent because a process can perform an external side effect and die before recording completion.

Its strength for this use case is explicit failure policy. Queues can configure retry limit, fixed delay or exponential backoff with a cap, job expiration, automatic worker heartbeats, and dead-letter routing. Heartbeats and expiration are independent: heartbeat detects dead workers; expiration limits total attempt duration ([queue options](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md#retry-options), [heartbeat and expiration](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md#heartbeat-options)). This gives substantially faster and more tunable abandoned-job recovery than Graphile Worker.

It also offers more deduplication/concurrency policies. `exclusive` permits one queued-or-active job, `key_strict_fifo` serializes by `singletonKey`, and other policies distinguish queued and active uniqueness; permanent failures can intentionally block a strict key until retry/delete ([queue policies](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md#-createqueuename-queue)). `upsert()` can update a not-yet-active job or create it if absent ([job upsert](https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md#upsertname-data-options)). These can model profile coalescing precisely, but the choice is less obvious than Graphile's single job-key mechanism and must be specified.

Workers poll by default and can add process-local concurrency. Optional `LISTEN/NOTIFY` is an optimization with polling as a safety net; when used through PgBouncer transaction/statement pooling, pg-boss warns and continues polling ([worker polling and concurrency](https://github.com/timgit/pg-boss/blob/master/docs/api/workers.md#work), [notification fallback](https://github.com/timgit/pg-boss/blob/master/docs/api/workers.md#low-latency-dispatch-with-listennotify)). This is the safest of the three maintained-library connection stories if only a transaction-pooled URL is available.

pg-boss owns and maintains a `pgboss` schema. `start()` migrates by default; migrations can be disabled so a separately privileged deployment step owns them ([constructor/migration options](https://github.com/timgit/pg-boss/blob/master/docs/api/constructor.md#migrate)). It also runs monitoring and maintenance tasks, retains terminal job state according to policy, and can persist warnings and queue-depth statistics ([operational options](https://github.com/timgit/pg-boss/blob/master/docs/api/constructor.md#operations-options)). Those are valuable once queue operations matter, but they are a larger initial surface than profile ingestion needs.

`stop()`/`offWork()` support waiting for active handlers, and handlers receive an `AbortSignal` ([worker shutdown](https://github.com/timgit/pg-boss/blob/master/docs/api/workers.md#offworkname-options), [handler contract](https://github.com/timgit/pg-boss/blob/master/docs/api/workers.md#work)). Unlike Graphile Worker's documented automatic signal behavior, the application entrypoint should explicitly translate SIGTERM/SIGINT into pg-boss shutdown and await its stopped lifecycle.

The current pg-boss package is ESM, supports Node `>=22.12`, and includes its own `pg` dependency, so Node 24 is compatible ([package metadata](https://github.com/timgit/pg-boss/blob/master/package.json)). It ships a Drizzle transaction adapter, but its current development matrix names a Drizzle 1.0 release candidate while this repository uses Drizzle 0.45 with `postgres.js` ([ORM adapters](https://github.com/timgit/pg-boss#orm-transaction-adapters), [this repository's dependencies](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/package.json#L27-L47)). Inference: if atomic enqueue with application writes is needed, verify the adapter against this exact driver/version in a small integration test; otherwise use pg-boss's native pool for queue operations.

## Recommended deployment shape

The deployment shape is the same for either maintained library:

1. Add `scripts/profile-ingestion-worker.ts` to the existing esbuild worker bundle so the final image contains `.output/worker/profile-ingestion-worker.mjs` and all runtime dependencies.
2. Keep the web container's existing command unchanged.
3. Run a second, always-on Coolify resource from the same source/image with the worker command, the same `DATABASE_URL` and GitHub credential, no public domain, and a small concurrency setting.
4. Apply the queue library's schema migration before the web app first calls its enqueue API. Do this explicitly in deployment, or carefully accept the library's locked startup migration behavior.
5. Preserve the existing GitHub budget guard inside the handler. Queue concurrency is not a substitute for the quota floor because live web traffic shares the token.
6. Keep product progress in application-owned rows (`entities.built_at` plus any future ingestion-status/progress model), not in a library's private queue tables.

Coolify officially describes Docker Compose as its multi-service build pack and treats services without a port/domain as private ([build packs](https://coolify.io/docs/applications/build-packs), [private Compose services](https://coolify.io/docs/knowledge-base/docker/compose#private-or-internal-services)). It also supports overriding an image entrypoint specifically to run a queue worker instead of the web process ([custom commands](https://coolify.io/docs/knowledge-base/docker/custom-commands#multiple-service-types-from-single-image)).

Inference: the least disruptive first deployment is a second Coolify application/resource pointing at the same repository and worker bundle, with a custom worker entrypoint. Moving the whole deployment to repository-owned Docker Compose would make web/worker topology explicit and can reuse one image definition, but it changes more deployment machinery than this primitive requires. Either path should allocate connection budgets deliberately: Graphile Worker defaults to ten connections (minimum two), and pg-boss defaults to a ten-connection pool.

## Decision boundary

Choose Graphile Worker if all of these are acceptable:

- direct/session Postgres connectivity is available to the worker;
- rare catastrophic worker death may leave a job unavailable for roughly four hours;
- application tables, not queue history, are the source of user-visible progress;
- fixed exponential retry is sufficient, with quota deferral handled by task logic.

Choose pg-boss if any of these are first-release requirements:

- heartbeat-based dead-worker recovery in minutes;
- explicit dead-letter/redrive operations;
- retained queue history, queue-depth telemetry, or richer per-key policies;
- the worker must operate correctly through a transaction-pooled URL using polling only.

Choose bespoke only if the architecture decides that queue rows and their lifecycle are part of the application's domain model and worth owning. Avoid choosing it merely to save one dependency.
