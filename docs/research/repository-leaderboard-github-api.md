# GitHub repository leaderboard metrics

Date: 2026-09-22

## Decision summary

Yes. A public GitHub repository leaderboard can fetch its default branch, count commits reachable
from that branch, count contributors, and collect several useful activity and popularity metrics.
The cleanest design is a small GraphQL query for the branch-specific commit count plus REST metrics
endpoints for contributor activity and repository metadata.

The leaderboard should publish its metric definitions and an `asOf` timestamp. “Contributor” can
mean distinct GitHub-linked authors, GitHub's contributor-statistics rows including anonymous
authors, or people who authored commits in a selected time window. These are different numbers.

## Core data

### Default branch

The REST repository response includes `default_branch`. The REST list-commits endpoint also accepts
`sha` as a branch or SHA and defaults to the repository's default branch. Therefore a REST client
can discover the branch and enumerate it without guessing whether it is `main`, `master`, or
something else. [Repository API](https://docs.github.com/en/rest/repos/repos), [list commits](https://docs.github.com/en/rest/commits/commits)

### Exact default-branch commit count

GraphQL exposes the default branch as `Repository.defaultBranchRef`. The ref's target can be
queried as a `Commit`; `Commit.history` represents the linear history from that commit, and
`CommitHistoryConnection.totalCount` gives the count without downloading every commit.

```graphql
query RepositoryLeaderboard($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    isArchived
    defaultBranchRef {
      name
      target {
        ... on Commit {
          oid
          history(first: 1) {
            totalCount
          }
        }
      }
    }
  }
}
```

This is a count of the commit history reachable from the default branch's current tip, following
the same linear-history concept as `git log`. It is not necessarily the same as “all commits ever
created in any branch,” and it can change after a force-push or branch rewrite. [GraphQL repository
reference](https://docs.github.com/en/graphql/reference/repos), [GraphQL Commit reference](https://docs.github.com/en/graphql/reference/commits)

The REST alternative is to request `/repos/{owner}/{repo}/commits?sha={default_branch}` and follow
pagination, but that is needlessly expensive for large repositories. The REST response is useful
when the application needs commit details anyway; its maximum page size is 100. [List commits
parameters](https://docs.github.com/en/rest/commits/commits)

### Contributor count

`GET /repos/{owner}/{repo}/stats/contributors` returns contributor rows with each contributor's
total commit count and weekly activity. GitHub says repository statistics are cached by the SHA of
the default branch, and pushing to that branch resets the cache. The statistics exclude merge
commits and empty commits. A first request can return `202` while GitHub computes the result, so
the worker must retry later and persist the last successful snapshot. [Repository statistics](https://docs.github.com/en/rest/metrics/statistics)

For a count, count the returned rows. Decide explicitly whether anonymous rows are included. The
separate `GET /repos/{owner}/{repo}/contributors?anon=true` endpoint can also list contributors,
but it is cached, identifies contributors by author email, and only links the first 500 author
email addresses to GitHub users; the remainder may be anonymous. It is therefore less suitable as
an “unique people” ground truth. [List repository contributors](https://docs.github.com/en/rest/repos/repos)

Recommended leaderboard fields:

```ts
{
  defaultBranch: string
  defaultBranchTipSha: string
  reachableCommitCount: number
  contributorCount: number
  anonymousContributorCount: number
  measuredAt: string
}
```

Store the contributor rows as well if the product may later show “top contributors,” contributor
concentration, or active contributors in the last 30/90/365 days.

## Good additional metrics

| Metric | GitHub source | Notes |
| --- | --- | --- |
| Commits per week for the last year | `stats/commit_activity` | 52-week activity series; statistics may be asynchronous. |
| Additions and deletions per week | `stats/code_frequency` | Useful for activity, but GitHub documents a limit of fewer than 10,000 commits for this endpoint. |
| Contributor commits by week | `stats/contributors` | Gives per-contributor totals and weekly additions, deletions, and commits. |
| Stars | Repository `stargazerCount` (GraphQL) or REST repository metadata | Popularity signal; snapshot it because it changes continuously. |
| Forks | Repository `forkCount` or REST repository metadata | Distinguish forks from active downstream projects. |
| Issues and pull requests | Repository metadata and connections | Prefer open counts, closed/merged counts, and recent rate over lifetime totals. |
| Recent activity | Repository `pushed_at`, releases, issues, pull requests, commits | “Active recently” is usually more meaningful than lifetime commits. |
| Languages and license | REST languages endpoint, repository metadata, community profile | Good categorization fields; community profile also reports documentation files and a health percentage. |
| Commit timing | `stats/punch_card` | Day/hour distribution; interesting but more descriptive than ranking-worthy. |

GitHub's metrics catalog documents commit activity, code frequency, contributor activity,
participation, and punch-card data. The community profile endpoint reports repository-health
signals such as license, README, contributing guide, issue template, and pull-request template.
[Metrics overview](https://docs.github.com/en/rest/metrics), [community profile](https://docs.github.com/en/rest/metrics/community)

Repository traffic (clones, views, and referrers) is potentially interesting, but it is an owner/
maintainer-oriented metric and should not be assumed available for arbitrary public repositories.
Treat it as an optional authenticated enrichment, not a foundation of a public all-repository
leaderboard. [Repository traffic](https://docs.github.com/en/rest/metrics/traffic)

## Suggested first version

Use a two-stage ingestion job:

1. Fetch repository metadata and the GraphQL default-branch history count.
2. Fetch contributor statistics and weekly commit activity, handling `202` by retrying with
   backoff.
3. Store each successful fetch with `measured_at`, the default branch name, and its tip SHA.
4. Rank only comparable snapshots: for example, “commits on default branch,” “contributors with
   at least one non-merge, non-empty commit,” and “commits in the last 90 days.”

For a first leaderboard, I would expose total reachable commits, total contributors, contributors
in the last year, commits in the last year, stars, forks, last push time, and a derived activity
score. Keep the raw counts visible so the score does not hide the definition.

The main engineering concern is quota and freshness, not API availability. Cache repository
snapshots, refresh popular or recently changed repositories more often, and avoid enumerating all
commits just to count them. Public repositories can be queried without authentication for the
documented public-resource endpoints, but an authenticated app/token gives better rate-limit
headroom and should still respect GitHub's primary and secondary limits.

## Measured while prototyping (2026-09-28)

Measured against `paritytech/polkadot-sdk` and about 20 other repositories while building the
prototype on the `feat/repo-leaderboard` branch.

### Costs

| Data | Request | GraphQL points |
| --- | --- | --- |
| Every current stock (stars, forks, watchers, open/closed issues, open/merged/closed PRs, releases, default branch + tip SHA, reachable commits, commits in the last 365 days) | one aliased `repository` query | 1 |
| 12 months of issues opened/closed, PRs opened/merged, and default-branch commits | 48 `search(type: ISSUE) { issueCount }` aliases + 12 `history(since, until)` aliases in one query, ~3.5 s | 1 |
| Star history | `stargazers(orderBy: STARRED_AT)`, 100 per page | ⌈stars / 100⌉ |
| Contributor total | REST `/contributors?per_page=1&anon=true`, read the `rel="last"` page number | REST, 1 request |

polkadot-sdk's complete history (106 months back to 2017-11, including 29 pages of stars) cost
39 points.

### Corrections to the section above

- **`/stats/contributors` is not a contributor count.** For most repositories it returns only the
  top 100 contributors: substrate, ink and polkadot-js/api return exactly 100 rows against 483,
  142 and 160 contributors listed by `/contributors?anon=true`. Very large repositories returned
  about 500 rows. It is still the only source of per-week, per-author activity, so the prototype
  uses it for active contributors, the bus factor and monthly contributor activity, and marks
  those numbers as lower bounds whenever the statistics have fewer rows than `/contributors`
  lists. The account-linked count can't be the yardstick: `/contributors` links only the first
  500 emails, so rust-lang/rust shows 442 linked against 499 statistics rows and 8,839 listed.
- `/stats/contributors` can answer `200 []` while it is still computing (seen on anza-xyz/agave),
  not only `202`. An empty list for a repository that has commits has to be treated as pending.
- `/contributors` answers 403 "history or contributor list is too large" for torvalds/linux, so
  the contributor count can be unknown.
- `history.totalCount` includes merge commits; the statistics endpoints exclude them. On
  polkadot-sdk the default branch has 20,309 commits while the statistics sum to 28,049. The two
  numbers measure different things and should never be shown as the same metric.
- Forks: `forks` lists only forks that still exist (1,169 against `forkCount` 1,254), so a
  fork-history back-fill would undercount.

### What can have history

| Metric | Back-fillable? | Finest resolution | How |
| --- | --- | --- | --- |
| Default-branch commits | yes, to the first commit | any window (day) | `history(since, until).totalCount` |
| Issues opened/closed, PRs opened/merged/closed | yes | any window (day) | search counts over `created:`, `closed:`, `merged:` |
| Open issues / open PRs at a past date | yes | day | `created:<=T` minus `closed:<=T` search counts |
| Stars | yes, but cost grows with stars | exact timestamp | `stargazers.starredAt`; unstarred stars are gone |
| Active / new contributors | yes, top-100 only | week | `/stats/contributors` weeks |
| Releases | yes | exact timestamp | `releases { createdAt }` |
| Forks | partially (deleted forks missing) | exact timestamp | `forks { createdAt }` |
| Watchers, contributor total, languages | no | from first snapshot | daily snapshot going forward |
