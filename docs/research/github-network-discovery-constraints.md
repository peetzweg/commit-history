# GitHub network discovery constraints

Research date: 2026-08-28

## Decision summary

The public network leaderboard does **not** require GitHub login. For any ordinary
public GitHub account, the REST endpoints for a specified username expose its
followers, following, and public organization memberships without authentication.
They can therefore be fetched by the existing server-side service token, cached in
Postgres, and refreshed by the proposed worker. Login is valuable for establishing
"me" and persisting product state, not for unlocking those public cohorts.

Use the REST API for relationship enumeration:

- `GET /users/{username}/following`
- `GET /users/{username}/followers`
- `GET /users/{username}/orgs`

Request `per_page=100`, follow the response's `Link` URLs until there is no next
page, save ETags per exact page URL, and reconcile each completed enumeration as a
set keyed by GitHub's immutable numeric user/organization `id`. The subject user is
not part of either relationship response, so include it explicitly in the product
cohort. Do not depend on API response order and do not recursively enumerate a
discovered account's own network.

Keep private organizations out of the public leaderboard baseline. If they are
later offered as a signed-in-only feature, fetch only the signed-in user's own
memberships with their user token and keep the result private. An OAuth App should
request `read:org` only at that point; public network discovery and login itself can
use no OAuth scope. A GitHub App user token has a more precise membership endpoint,
`GET /user/memberships/orgs`, which GitHub documents as requiring no fine-grained
permission; do not use `GET /user/orgs` with a fine-grained token because GitHub
documents that combination as returning an empty list.

## What each credential can see

| Credential | Followers and following for a named user | Organizations for a named user | Identity / own private organizations | Primary quota |
| --- | --- | --- | --- | --- |
| Anonymous | Public relationship lists | Public memberships only | No authenticated identity; no private memberships | REST: 60 requests/hour per source IP |
| Existing service token | Same public lists, with a larger quota | Public memberships for arbitrary users. Any private access belongs only to the token owner and must not be treated as target-user data | Identifies the operator account, not the visitor | A classic PAT uses its owner's 5,000 REST requests/hour and 5,000 GraphQL points/hour |
| OAuth App user token | Same public lists; use the named-user endpoints | Public memberships for arbitrary users | `GET /user` identifies the signed-in user. `read:org` is the minimum narrow scope for private organization membership; no scope is sufficient for public identity/data | 5,000 REST requests/hour and 5,000 GraphQL points/hour per user, shared with other apps and PATs acting as that user |
| GitHub App user token | Same public named-user endpoints with no permission. The `/user/followers` and `/user/following` forms instead require account `Followers: read` | Public named-user memberships with no permission | `GET /user` identifies the user. For all own memberships, `GET /user/memberships/orgs` is documented for GitHub App user tokens with no fine-grained permission; organization policy/SAML and the user's access can still constrain access | Same per-user 5,000 REST requests/hour and 5,000 GraphQL points/hour, shared with other user-authorized credentials |

GitHub explicitly documents both named-user follower endpoints as usable without
authentication and, when a fine-grained token is supplied, as requiring no
permission. Each returns public user objects including `login`, numeric `id`, and
GraphQL `node_id`. The corresponding authenticated-user endpoints are a different
contract: a GitHub App user token needs `Followers: read`. Follow/unfollow mutations
need `Followers: write`, or the classic OAuth `user:follow` scope, and are not needed
by this product. [REST follower endpoints](https://docs.github.com/en/rest/users/followers)

`GET /users/{username}/orgs` always lists only public memberships, regardless of
authentication. `GET /user/orgs` can include memberships visible to an OAuth App,
but classic OAuth/PAT credentials need at least `user` or `read:org`; GitHub also
warns that fine-grained tokens get an empty list on that endpoint. For GitHub App
user tokens, the separate `GET /user/memberships/orgs` endpoint says it lists all
authenticated-user memberships and requires no fine-grained permission.
[Organization endpoints](https://docs.github.com/en/rest/orgs/orgs)
[Organization membership endpoints](https://docs.github.com/en/rest/orgs/members)

For an OAuth App, `(no scope)` grants read-only access to public information.
`read:org` grants read-only access to organization and team membership. `user:follow`
is a write-capable follow/unfollow scope and should not be requested. GitHub recommends
minimum scopes and generally recommends GitHub Apps over OAuth Apps when their finer
permissions are useful. [OAuth App scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)

GitHub Apps have implicit permission to read public resources when acting on behalf
of a user. A user access token is constrained by both what the app and user may
access; SAML and organization authorization can change that access over time.
[Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
[GitHub App security guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)

### Existing service token in this repository

The environment variable is named `GITHUB_TOKEN`, but in this deployment it is an
operator-owned classic PAT, not GitHub Actions' built-in token. The README and
`.env.example` say it has `read:user`; all live public-user requests share it.
The organization refresh code separately says member enumeration needs `read:org`,
and preserves a 500-point GraphQL floor for live traffic. That is an existing
documentation/configuration mismatch worth verifying in deployment, but neither
scope is needed merely to enumerate public networks.
[README](../../README.md)
[Environment example](../../.env.example)
[Organization refresh worker](../../scripts/refresh-orgs.ts)
[Server token call site](../../src/lib/commit-history.ts)

## Identity: store an immutable GitHub ID

GitHub advises storing the REST `id` as the durable user key: it never changes for
that user and is never reused for a different user. Handles, organization slugs, and
email addresses can change. GraphQL also exposes an opaque global node `id`, while
REST responses include that value as `node_id`; either is useful for GraphQL lookup,
but the numeric REST `id` is the explicitly recommended account key.
[GitHub App identity guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#use-a-user-id-as-the-primary-key)
[REST user response](https://docs.github.com/en/rest/users/users#get-a-user)
[GraphQL User schema](https://docs.github.com/en/graphql/reference/users#user)

This matters to the current model: `entities.id` is currently derived from the
mutable login (`user:torvalds`), and `github_node_id` is described and populated as
org-only. The network model or entity model needs an immutable GitHub account ID and
a unique constraint on `(kind, github_account_id)`; `login` should remain mutable
display/routing data. This is an inference from GitHub's identity guarantee and the
current schema, not an implementation performed by this research.
[Current entity schema](../../src/lib/db/schema.ts)

## Pagination, ordering, and cohort size

The three REST list endpoints default to 30 results per page and permit at most 100.
GitHub directs clients to traverse the URLs in the `Link` response header rather than
constructing page URLs themselves. [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)

The follower/following endpoint contracts offer only `page` and `per_page`; they do
not offer a sort or direction parameter. The GraphQL `followers` and `following`
connections likewise expose cursor and page-size arguments but no `orderBy`.
Therefore, API order is not a product guarantee: persist a membership set and apply
the leaderboard's own metric ordering after joining contribution data.
[REST follower endpoint parameters](https://docs.github.com/en/rest/users/followers#list-the-people-a-user-follows)
[GraphQL User connections](https://docs.github.com/en/graphql/reference/users#fields)

GitHub documents no small maximum cohort size. Cost scales linearly by page:

- 1-100 relationships: 1 REST request
- 101-200 relationships: 2 REST requests
- 10,000 relationships: 100 REST requests

The existing GraphQL profile fetch already obtains `followers.totalCount` and
`following.totalCount` in the same profile query, so the worker can know the expected
scale before enumerating. A progressive leaderboard is therefore the right shape:
store discovered edges page by page and queue unseen profiles, while reporting
`ready tracked profiles / discovered cohort`. Mark a relationship snapshot complete
only after every page succeeds; otherwise a partial crawl must not delete edges that
were merely on an unfetched page.
[Current profile query](../../src/lib/github.ts)

GraphQL is a viable alternative but not necessary here. It requires authentication,
connections require `first` or `last` between 1 and 100, and pagination is cursor
based. The schema provides `totalCount`, but follower/following still lack an ordering
argument. REST has the simpler one-request-per-100 accounting and supports HTTP
conditional requests directly.
[GraphQL authentication](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql)
[GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)

## Quotas and refresh behavior

GitHub's current primary limits relevant here are:

- unauthenticated REST public requests: 60/hour per source IP;
- PAT, OAuth App user token, or GitHub App user token: normally 5,000 REST
  requests/hour per user;
- GraphQL user credentials: normally 5,000 points/hour per user;
- REST and GraphQL use separate primary buckets, but user-token requests share their
  respective user bucket with other apps and PATs acting as that user.

GitHub also enforces secondary limits shared across REST and GraphQL: no more than
100 concurrent requests, normally no more than 900 REST endpoint points/minute and
2,000 GraphQL endpoint points/minute, plus CPU-time and undisclosed abuse limits.
These are ceilings, not operating targets, and GitHub can change secondary limits.
The proposed worker should remain serialized or tightly bounded, respect
`Retry-After` and reset headers, and preserve the existing live-traffic reserve.
[REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
[GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)

For refreshes, save the `ETag` (or `Last-Modified` where present) for every exact
paginated REST URL and send `If-None-Match` on the next pass. GitHub says a correctly
authorized conditional request that returns `304 Not Modified` does not consume the
primary rate limit. A changed page returns `200` and consumes quota; conditional
requests do not eliminate secondary-limit considerations. Keep the URL, API version,
accept header, and `per_page` stable to maximize useful `304`s.
[REST conditional-request guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)

## Decision consequences for the map

1. Public Following + self, Followers + self, and public-Organizations cohorts can
   ship before authentication and use the reusable ingestion queue.
2. Network discovery should be a bounded first-degree snapshot. Discovered users
   become tracked entities and ingestion jobs, not application accounts, and their
   own networks are not fetched until someone visits them.
3. GitHub login remains useful for a direct "mine" route, saved custom lists,
   preferences, and cross-device retention. It should not gate public exploration.
4. Baseline OAuth login needs no scope. Add `read:org` only if signed-in private-org
   cohorts are deliberately added; never request `user:follow` for this product.
5. Add immutable GitHub account IDs before relationship persistence. A login-derived
   primary key is not sufficient across GitHub renames.
6. Refresh relationship snapshots asynchronously with per-page ETags, completion
   markers, and the shared service-token rate budget. Do not perform a full network
   fan-out in the profile request path.
