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

## 🖼️ Embed in your README

Drop a live, auto-updating chart into any markdown file. This `<picture>` snippet follows the viewer's GitHub theme and links back to your full history:

```html
<a href="https://commit-history.com/YOUR_USERNAME">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://commit-history.com/embed/YOUR_USERNAME?theme=dark" />
    <img alt="YOUR_USERNAME's commit history" src="https://commit-history.com/embed/YOUR_USERNAME" />
  </picture>
</a>
```

Prefer plain Markdown? `[![commit history](https://commit-history.com/embed/YOUR_USERNAME)](https://commit-history.com/YOUR_USERNAME)` works too (append `?theme=dark` for dark mode). Here's [Linus Torvalds](https://commit-history.com/torvalds):

[![Linus Torvalds' commit history](https://commit-history.com/embed/torvalds)](https://commit-history.com/torvalds)

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

## ☁️ Deploy (Netlify)

The app is wired for Netlify via [`@netlify/vite-plugin-tanstack-start`](https://www.npmjs.com/package/@netlify/vite-plugin-tanstack-start) (already in `vite.config.ts`). Settings (also in `netlify.toml`):

| Setting | Value |
| --- | --- |
| **Build command** | `vite build` |
| **Publish directory** | `dist/client` |
| **Functions directory** | _(leave blank — the plugin emits `.netlify/v1/functions/` automatically)_ |
| **Environment variables** | `GITHUB_TOKEN` (required), `DATABASE_URL` (for the persistent cache + leaderboard) |

## 🛠️ Tech

TanStack Start + React 19 · TanStack Query · Tailwind v4 · Drizzle + Neon Postgres · Biome.

---

<p align="center"><sub>A loving homage to <a href="https://www.star-history.com">star-history.com</a>.</sub></p>
