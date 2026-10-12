# commit-history

TanStack Start (React, vite + nitro) app on Coolify (Hetzner) behind Cloudflare.
Self-hosted Postgres 18 on the same box; drizzle + postgres.js. Infra runbooks and
the self-hosting playbook live in the private `peetzweg/devops` repo.

## Hard rules

- **pnpm only.** Never bun/npm for installs — the lockfile deploys via `--frozen-lockfile`.
- **Server-only libraries must never sit in a client-reachable import graph.** Route files
  and the server-fn modules (`src/lib/commit-history.ts`, `src/lib/org.ts`) are shared with
  the client bundle; a top-level import of a Node-only lib there ships it to (or crashes)
  the browser. Load such libs via dynamic import behind a server check — see
  `src/lib/db/index.ts` (postgres.js, "Buffer is not defined" incident) and
  `optimizeDeps.exclude` in `vite.config.ts` (@resvg/resvg-js, dev optimizer crash).
  Verify any change near this graph **in a real browser** — curl only proves SSR.
- **Databases:** the local files intentionally select different databases on the same Postgres
  host (`coolify:5432` over Tailscale): `.env` → production `commit_history`; `.env.new` →
  development `commit_history_dev`. Never print either URL because it contains credentials;
  verify a target safely by parsing `new URL(process.env.DATABASE_URL).pathname` and checking the
  database name before any write. `drizzle.config.ts` loads `.env`, so an unqualified
  `pnpm db:migrate` targets **production** in this checkout. Use explicit commands instead:
  `node --env-file=.env.new ./node_modules/drizzle-kit/bin.cjs migrate` for development, and only
  with deliberate production authorization use
  `node --env-file=.env ./node_modules/drizzle-kit/bin.cjs migrate`. Node does not overwrite an
  existing `DATABASE_URL` when the config subsequently loads `.env`, so the `.env.new` selection
  remains effective. `pnpm db:refresh-dev` resets dev to a prod copy. No DB configured → the app
  falls back to an in-memory store; that's supported.
- **Ambient `GITHUB_TOKEN` in the shell shadows `.env`** and lacks `read:org` — prefix
  dev/bun script runs with `env -u GITHUB_TOKEN` when org lookups misbehave.

## Background jobs

Background jobs run as pg-boss queues inside the profile worker
(`scripts/profile-ingestion-worker.ts`), not as Coolify scheduled tasks: `org-refresh` is queued
lazily by org views, `monthly-user-refresh` by a pg-boss cron the worker registers on startup
(`src/lib/monthly-refresh-queue.ts`). Each job is a bounded **slice** that re-queues itself until
nothing is due, so a deploy or crash costs one slice. Every pg-boss instance needs an `error`
listener, or a database blip kills the worker. Logic goes in a pure engine (`src/lib/<job>.ts`)
over an injected store (`<job>-store.ts`) so it unit-tests against fakes; a CLI in `scripts/`
stays for local runs (`pnpm refresh:orgs`, `pnpm monthly:user`).

Every job must: take its advisory lock from `LOCK_KEYS` in `src/lib/job-runner.ts` (unique key
per job); use `createBudgetGuard` so it can't drain the GitHub token below the floor that live
traffic needs; stop cleanly on a wall-clock cap instead of being killed; resume off a DB
freshness marker (**the missing row is the retry queue** — no job-state table); write only
idempotent upserts; isolate per-item failures to a narrow status allowlist; and emit one
greppable `<job> done status=… ` summary line. Size the **unit of work** so no single item can
monopolise a run — `refresh-orgs` works one (org, member) pair at a time precisely because
one-org-at-a-time made a 4,000-member org an indivisible multi-hour job that could never finish. Keep
crons off 03:00 UTC: the daily database backup runs then and can stall connections.

Two failure modes worth knowing: cleanup must release the lock **first and defensively**, or a
crash mid-teardown leaves it held by a server-side session that outlives the process and every
later run reports `status=locked` and silently does nothing; and never let pool shutdown throw,
or a completed run shows up as a failed Coolify execution.

## Domain guardrails

- Single-segment paths are GitHub logins (`$user` route); editorial pages live under the
  reserved `/-/` namespace so they can never shadow a login. Expect vuln-scanner probes
  (`/wp-admin`, `/actuator`) to resolve into real lookups — that's known, see the guards.
- Server functions are guarded (same-origin check + per-IP rate limit in `src/start.ts`);
  SSR pages and `/embed/*` are deliberately unguarded app-side — the edge (Cloudflare)
  owns those. Embed renders must never record lookups (`record: false`).
- `robots.txt` is host-aware (`src/routes/robots[.]txt.tsx`): prod allows all, preview
  hosts deny all. Don't reintroduce a static robots.txt.
