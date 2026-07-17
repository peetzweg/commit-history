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
- **Databases:** `DATABASE_URL` in `.env` should point at `commit_history_dev`
  (reached over Tailscale: `coolify:5432`). Production (`commit_history`) is the same host,
  used from a laptop only deliberately (moderation via `pnpm suspend`, dumps via
  `pnpm backup`). `pnpm db:refresh-dev` resets dev to a prod copy. No DB configured →
  the app falls back to an in-memory store; that's supported.
- **Ambient `GITHUB_TOKEN` in the shell shadows `.env`** and lacks `read:org` — prefix
  dev/bun script runs with `env -u GITHUB_TOKEN` when org lookups misbehave.

## Domain guardrails

- Single-segment paths are GitHub logins (`$user` route); editorial pages live under the
  reserved `/-/` namespace so they can never shadow a login. Expect vuln-scanner probes
  (`/wp-admin`, `/actuator`) to resolve into real lookups — that's known, see the guards.
- Server functions are guarded (same-origin check + per-IP rate limit in `src/start.ts`);
  SSR pages and `/embed/*` are deliberately unguarded app-side — the edge (Cloudflare)
  owns those. Embed renders must never record lookups (`record: false`).
- `robots.txt` is host-aware (`src/routes/robots[.]txt.tsx`): prod allows all, preview
  hosts deny all. Don't reintroduce a static robots.txt.
