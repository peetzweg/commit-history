<p align="center">
  <a href="https://commit-history.com">
    <img src="public/og.png" alt="Commit History — a star-history for GitHub commits" width="640" />
  </a>
</p>

<h1 align="center">Commit History</h1>

<p align="center">
  <strong>A <a href="https://www.star-history.com">star-history</a>, but for commits.</strong><br/>
  Watch any GitHub user's commits stack up across their whole lifetime — as one satisfying, rising chart.
</p>

<p align="center">
  <a href="https://commit-history.com"><b>🌍 commit-history.com</b></a>
</p>

---

Type a username, get their entire coding career as a curve. It's a little hypnotic, it's a great flex, and it drops straight into your README.

👉 **[commit-history.com/torvalds](https://commit-history.com/torvalds)** · **[/gaearon](https://commit-history.com/gaearon)** · **[/sindresorhus](https://commit-history.com/sindresorhus)**


## ✨ What you get

- **📈 Lifetime commit curve** — every public commit since the account was born, accumulated month by month. The same data as the green contribution graph, not the noisy issues/PRs calendar.
- **⚔️ Compare anyone** — throw in comma-separated names (`/torvalds,gaearon,antfu`) and race their trajectories on one chart. Flip to **Aligned** mode to line everyone up at "month zero" regardless of when they joined.
- **🏆 Leaderboard** — an all-time ranking of everyone who's been looked up, sortable by public commits, private contributions, total activity, or **followers**.
- **🔒 Public & private** — for users who expose private contributions, see the hidden half of their activity too (kept separate, never silently summed).
- **🖼️ Embed it anywhere** — a live SVG chart for your own README (see below).
- **✏️ Hand-drawn charm** — an xkcd-style sketch aesthetic, a deliberate homage to the original.

## 🖼️ Embed in your GitHub profile

Drop a live, auto-updating chart into your profile page or any markdown file. This snippet centers the chart, follows the viewer's GitHub theme (light/dark), and links back to your full history:

```html
<div align="center">
  <a href="https://commit-history.com/YOUR_USERNAME">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://commit-history.com/embed/YOUR_USERNAME?theme=dark" />
      <img alt="YOUR_USERNAME's commit history" src="https://commit-history.com/embed/YOUR_USERNAME" />
    </picture>
  </a>
</div>
```

Here's [Linus Torvalds](https://commit-history.com/torvalds):

<div align="center">
  <a href="https://commit-history.com/torvalds">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://commit-history.com/embed/torvalds?theme=dark" />
      <img alt="Linus Torvalds' commit history" src="https://commit-history.com/embed/torvalds" />
    </picture>
  </a>
</div>

## 🚀 Quick start

```bash
pnpm install
cp .env.example .env   # add your token (and optionally a database URL)
pnpm dev               # → http://localhost:3000
```

```ini
# .env
GITHUB_TOKEN=<classic PAT with the read:user scope>   # required
DATABASE_URL=<neon postgres url>                       # optional — see caching below
```

A classic Personal Access Token with `read:user` is enough for the **public** commits of any user.

## 🧠 How it works

- Data comes from GitHub's **GraphQL API** (`user.contributionsCollection.totalCommitContributions`). A window spans at most a year, so a lifetime is sliced into **monthly windows** and fetched in batched, parallel queries (`src/lib/github.ts`) — one big query per month trips GitHub's resource limits on older accounts.
- All fetching happens in **server functions** (`src/lib/commit-history.ts`), so the token never reaches the browser.
- The chart is **hand-rolled inline SVG** (`src/components/CommitChart.tsx`) — no chart library — which is what makes the xkcd filter and the standalone embed (`src/lib/chart-svg.ts`) possible.
- **Caching** (`src/lib/cache.ts`) is incremental: past months are immutable, so a returning user only re-fetches the trailing month. With `DATABASE_URL` set it persists to **Neon Postgres** (via Drizzle) and powers the leaderboard + recent lookups; without it, it falls back to an in-memory cache so the app still runs.

## 🛡️ Moderation

Some accounts game the board (botted commits, bought followers). To hide one until you've
investigated, suspend it — a soft, reversible flag (`entities.suspended_at`). Suspended
accounts drop off the leaderboard and "recently looked up" but stay directly viewable with an
under-review notice. Run with [bun](https://bun.sh) (it auto-loads your local `.env`):

```bash
bun run suspend <login> "botted commits"   # suspend (asks to confirm)
bun run suspend --remove <login>           # reactivate
bun run suspend --list                     # list suspended accounts
```

## 🔄 Refreshing profiles

Profile metadata (followers, repos, bio, …) is fetched on lookup and cached. To re-pull it from
GitHub manually — e.g. someone's follower count is stale — refresh it. Needs `GITHUB_TOKEN` and
`DATABASE_URL` in `.env`; run with [bun](https://bun.sh) (it auto-loads your local `.env`):

```bash
bun run refresh <login>   # refresh one account
bun run refresh           # refresh only un-backfilled rows (followers is null)
bun run refresh --all     # refresh every user
```

### Monthly contribution refresh (scheduled)

Contribution *months* are a separate axis from profile metadata. Lookups only ever fetch completed
months, so the month that just ended stays missing from a cached profile until someone views it.
A scheduled worker fills it in for the users who are actually visible: the deduped union of the
top 500 of every leaderboard.

```bash
pnpm monthly:user --dry-run            # preview the cohort, no GitHub calls, no writes
pnpm monthly:user --help               # every flag and its env var
```

In production it runs as a Coolify **scheduled task** on the app image, no separate service:

| Setting | Value |
| --- | --- |
| **Command** | `node .output/worker/monthly-user-refresh.mjs` |
| **Schedule (UTC)** | `0 3 1 * *` main pass · `0 9 1 * *` and `0 3 2 * *` retry passes |

Run it several times rather than once. Every pass is idempotent: users whose target month is
already **complete** are skipped without a GitHub call, so an incomplete month row *is* the retry
queue.

"Complete" means the row's `monthly_commits.fetched_at` is at/after the month's own end — not
merely that a row exists. Those differ: before `a44f442` a lookup mid-month stored a few days of
data under the whole month's label, and the 2026-08-01 pass skipped 2229 of 2230 candidates
because a row was present. A NULL `fetched_at` (written before the column existed) counts as
incomplete, so anything unproven gets re-read rather than trusted.
Overlapping runs are prevented by a Postgres advisory lock (the loser exits 0). The worker
enforces the UTC month boundary itself — it refuses to touch an incomplete month and exits early
if invoked before `MONTHLY_USER_SAFE_AFTER_UTC` on the 1st — so scheduler timezone drift can't
record a half-finished month. It also stays above a reserved GraphQL points floor, since the
token is shared with live traffic.

A login GitHub stops resolving (deleted, renamed) is stamped `entities.unreachable_at` and drops
out of the cohort. That is **not** moderation: unlike `suspended_at` it keeps the profile ranked and
viewable, with a notice — the stored contributions were real, there is just nothing left to fetch.
Without it one dead account fails every pass of every month forever, since an incomplete month row
is the retry queue. A later lookup that resolves clears the flag automatically.

## ☁️ Deploy (self-hosted)

The build emits a standalone Node server via [nitro](https://nitro.build) — `pnpm build && pnpm start` serves the whole app on port 3000. The multi-stage `Dockerfile` packages exactly that, so any Docker host works; production runs on [Coolify](https://coolify.io) (build pack: Dockerfile, port 3000) behind Cloudflare, which edge-caches `/embed/*` — the embeds already send `s-maxage` for any CDN.

| Setting | Value |
| --- | --- |
| **Build** | `docker build .` (or `pnpm build` for bare Node) |
| **Run** | container `CMD` / `pnpm start` → listens on `:3000` (`PORT` overridable) |
| **Scheduled task** | `node .output/worker/monthly-user-refresh.mjs` (see above) |
| **Environment variables** | `GITHUB_TOKEN` (required), `DATABASE_URL` (for the persistent cache + leaderboard) |

## 🛠️ Tech

TanStack Start + React 19 · TanStack Query · Tailwind v4 · Drizzle + Neon Postgres · Biome.

---

<p align="center"><sub>A loving homage to <a href="https://www.star-history.com">star-history.com</a>.</sub></p>
