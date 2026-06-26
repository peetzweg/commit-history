# commit-history

A [star-history](https://star-history.com), but for a **GitHub user's cumulative commits** over their whole lifetime. Visit `/<username>` (e.g. `/peetzweg`) to see a rising area chart of total commits over time.

## How it works

- Data comes from GitHub's **GraphQL API**, field `user.contributionsCollection.totalCommitContributions`. That's commits-only (the same definition as the green contribution graph), not the mixed issues/PRs/reviews of the contribution calendar.
- A `contributionsCollection` window spans at most one year, so the account's lifetime is sliced into **monthly windows** (`src/lib/github.ts`). Those windows are fetched in **batched, parallel** aliased queries — a single query with one alias per month trips GitHub's "resource limits for this query exceeded" on older accounts — then accumulated into a cumulative series.
- The fetch runs in a **server function** (`src/lib/commit-history.server.ts`), so the GitHub token never reaches the browser. The `/$user` route loads it server-side and renders the chart (`src/components/CommitChart.tsx`, Recharts).

## Setup

```bash
pnpm install
cp .env.example .env   # then add your token
pnpm dev               # http://localhost:3000
```

`.env`:

```
GITHUB_TOKEN=<classic PAT with read:user scope>
```

A classic Personal Access Token with `read:user` is enough for **public** contributions of any user.

## About the token, rate limits, and scaling

The MVP uses **one server-side PAT** for every request. Things to know:

- **It's attached to your account** and shares **your** GraphQL budget (**5,000 points/hour**). Every visitor's chart spends from that one pool. Fine for personal/demo use.
- A *cold* chart costs roughly `ceil(months / 12)` GraphQL requests (one per batch). Even a 15-year-old account is ~15 cheap requests — far lighter than star-history, which paginates thousands of stargazers and needs a donated token pool. We don't.
- **Caching is built in** (`src/lib/cache.ts`). Completed past months are immutable, so a returning user only re-fetches the *trailing* month(s) — a warm request is one tiny GraphQL call (or zero, within a 60s window). A 7-day full-rebuild TTL catches backfilled history (rebases, repos made public, identity changes) that can alter long-past months. The store is in-memory/per-instance for now; the production swap is a shared store (KV / Redis / SQLite) behind the same two functions.
- **Scaling path** beyond caching, in order of effort:
  1. **GitHub OAuth sign-in** — each signed-in user's queries use *their own* token and budget, and it unlocks their **private** contributions. This is the natural answer to "can users sign in with GitHub."
  2. **GitHub App** — installation tokens for higher, scalable limits if it goes properly public.

## Roadmap

- [x] **Embeddable chart** for READMEs — `GET /embed/<user>` returns standalone `image/svg+xml` (xkcd font + filter inlined), `?theme=dark` supported. The user page shows a copy-paste markdown snippet. (`src/routes/embed.$user.tsx`, `src/lib/chart-svg.ts`)
- [x] **Compare multiple users** on one chart — comma-separated logins (`/peetzweg,torvalds,gaearon`); add/remove from the legend. One round-trip, partial-failure tolerant. (`getCommitHistories`, `src/components/MultiCommitChart.tsx`)
- [x] **Aligned timelines** toggle — `Date` (calendar) vs `Aligned` (months since each account's creation), to compare trajectories regardless of when each person joined.
- [x] Incremental server-side caching (in-memory; swap for a shared store in prod).
- [ ] Deploy to Vercel.
- [ ] Multi-user embed (`/embed/a,b,c`) — the embed is single-user for now.
- [ ] (Stretch) "who's taking off" trending view — requires storing snapshots over time.

---

Scaffolded with `@tanstack/cli` (TanStack Start + React 19, TanStack Query, Tailwind 4, shadcn, Biome).
