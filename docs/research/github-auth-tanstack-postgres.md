# GitHub-only authentication for TanStack Start and Postgres

Research for [Research GitHub-only authentication for TanStack Start and Postgres](https://github.com/peetzweg/commit-history/issues/184), captured on 2026-08-28.

## Answer

Use **Better Auth with its GitHub social provider, Drizzle adapter, and database-backed opaque sessions**, mounted as a TanStack Start server route at `/api/auth/$`. Register a GitHub OAuth App for the first release, request only the identity access Better Auth needs, and do not use the user's OAuth token for network-leaderboard ingestion. Keep the browser session first-party on `commit-history.com`, set the public auth base URL explicitly per environment, and keep all secrets runtime-only in Coolify.

This is the best-supported self-hosted fit for the current stack:

- Better Auth publishes a specific TanStack Start integration that mounts `auth.handler(request)` behind `GET` and `POST` handlers in `src/routes/api/auth/$.ts`; it also supplies `tanstackStartCookies()` for calls through its server API. Its guide recommends the client SDK for sign-in. [Better Auth: TanStack Start integration](https://better-auth.com/docs/integrations/tanstack)
- Better Auth publishes a GitHub provider and a first-party Drizzle adapter with PostgreSQL support and schema generation. [Better Auth: GitHub](https://better-auth.com/docs/authentication/github) [Better Auth: Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)
- TanStack Start itself supports raw server routes for authentication and documents both DIY authentication primitives and Better Auth as an open-source option. The DIY route is viable, but would make this project responsible for implementing and maintaining session issuance, OAuth state and PKCE, revocation, CSRF defenses, and rotation. [TanStack Start: server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes) [TanStack Start: authentication overview](https://tanstack.com/start/latest/docs/framework/react/guide/authentication-overview)

Auth.js is named by TanStack as another open-source option, and Clerk/WorkOS are supported managed alternatives, but the primary sources found do not offer the same documented TanStack Start + Drizzle/Postgres integration path. For a GitHub-only, self-hosted feature, they add integration work or an external identity dependency without an identified benefit.

## Current application seams

### Observed in this repository

- The app is TanStack Start, emitted as a Nitro Node server and run as `node .output/server/index.mjs` in a Node 24 container. The runtime image contains only `.output`. [package.json](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/package.json) [Dockerfile](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/Dockerfile)
- Raw `server.handlers` routes are already used for webhooks. The auth handler can use the same Web `Request`/`Response` seam. [Stripe webhook route](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/src/routes/%5B-%5D.api.stripe-webhook.tsx)
- `src/start.ts` installs TanStack's CSRF and rate-limit middleware only for `serverFn` handlers. An auth server route therefore does not receive those two filters; Better Auth must retain its own origin/CSRF, state, PKCE, and rate-limit protections. [start.ts](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/src/start.ts)
- Drizzle uses `postgres.js`, exports its schema from `src/lib/db/schema.ts`, and already generates checked-in migrations under `drizzle/`. `db` is nullable when `DATABASE_URL` is absent, which is useful for today's public cache but is not acceptable for auth: production auth initialization should fail closed if the database or auth configuration is missing. [database client](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/src/lib/db/index.ts) [Drizzle config](https://github.com/peetzweg/commit-history/blob/ce79f18bb99d905df49ee7c749452ca12fb13112/drizzle.config.ts)

### Integration shape (inference)

The least surprising module shape is:

1. A server-only auth module constructs Better Auth with the non-null Postgres Drizzle client, the generated auth schema, and only `socialProviders.github` enabled.
2. `src/routes/api/auth/$.ts` forwards `GET` and `POST` to `auth.handler(request)`. This route owns `/api/auth/sign-in/social`, `/api/auth/callback/github`, session lookup, and sign-out.
3. A client-only auth module creates the Better Auth client; the GitHub button calls `signIn.social({ provider: "github" })`.
4. Protected server functions pass request headers to `auth.api.getSession`. Page guards improve navigation UX, but every server function or route that reads or writes account-owned data checks the session itself. TanStack explicitly says route guards are not the data security boundary. [TanStack Start: authentication overview](https://tanstack.com/start/latest/docs/framework/react/guide/authentication-overview) [Better Auth: TanStack Start integration](https://better-auth.com/docs/integrations/tanstack)
5. The existing public routes and anonymous network leaderboards remain public. Authentication gates only saved lists, preferences, and other member-owned state.

There is no need to add a separate auth service or expose Postgres publicly. The same Nitro process can handle callbacks and sessions through the existing private database connection.

## Sessions, cookies, CSRF, state, and PKCE

### Documented facts

- With a database configured, Better Auth stores sessions server-side. Its primary cookie is an opaque, secret-signed session identifier; the optional session-data cookie is absent unless cookie caching is enabled. Sessions expire after seven days by default and refresh after the one-day update-age threshold. [Better Auth: cookies](https://better-auth.com/docs/concepts/cookies) [Better Auth: security](https://better-auth.com/docs/reference/security)
- Better Auth cookies are `HttpOnly`; production/HTTPS cookies are `Secure`; and `SameSite=Lax` is the default. [Better Auth: security](https://better-auth.com/docs/reference/security)
- Better Auth validates origins and Fetch Metadata for CSRF defense. Disabling either the CSRF or origin checks removes meaningful protection and should not be used. [Better Auth: security](https://better-auth.com/docs/reference/security)
- For OAuth, Better Auth stores state and PKCE material. With a database, the default state strategy stores the state payload in the verification table and a signed correlation value in a short-lived cookie, then deletes/expires both after the callback. [Better Auth: security](https://better-auth.com/docs/reference/security) [Better Auth: options](https://better-auth.com/docs/reference/options)
- GitHub independently recommends unpredictable `state` and PKCE with `S256`; the token exchange must submit the matching `code_verifier`. The authorization code expires after ten minutes. [GitHub: authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

### Recommendation / inference

- Keep the default database-backed session and OAuth-state strategies. They fit the shared Postgres deployment and support immediate session revocation.
- Do not enable the session cookie cache initially. It is unnecessary at the expected scale and makes database changes to session/user data temporarily stale.
- Do not enable cross-subdomain cookies. Serve the auth API from the same `commit-history.com` origin so the cookie remains host-only and avoids third-party-cookie/ITP failure modes. Better Auth specifically recommends a same-origin proxy or shared parent domain when frontend and auth API differ. [Better Auth: cookies](https://better-auth.com/docs/concepts/cookies)
- Keep Better Auth's CSRF/origin checks enabled even though the current TanStack middleware protects server functions. The callback and sign-in endpoints are raw server routes and need the auth library's protections.
- Store Better Auth's signing/encryption secret as a long random runtime secret and plan rotation using its versioned-secret mechanism. Better Auth throws in production when no secret is configured. [Better Auth: options](https://better-auth.com/docs/reference/options)
- Configure database-backed rate-limit storage if more than one app replica is ever deployed. Better Auth's production rate limiting defaults to in-memory storage, which is per-process; it supports a database rate-limit table when shared enforcement is needed. [Better Auth: rate limiting](https://better-auth.com/docs/concepts/rate-limit)

## GitHub OAuth App versus GitHub App

### Documented facts

- Better Auth supports credentials from either a GitHub OAuth App or a GitHub App. Its standard GitHub setup requests `user:email`; for a GitHub App it says to enable read-only **Email addresses** account permission. Better Auth currently requires an email field on every local user, though it documents using GitHub's stable numeric profile ID to create a non-routable placeholder when email is absent. [Better Auth: GitHub](https://better-auth.com/docs/authentication/github) [Better Auth: handling providers without email](https://better-auth.com/docs/concepts/oauth#handling-providers-without-email)
- GitHub says an OAuth token with no scope can read public information. `user:email` reads private email addresses; `user` would also include profile write and follow/unfollow permissions and is therefore unnecessarily broad here. [GitHub: OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- GitHub generally prefers GitHub Apps for fine-grained permissions, repository selection, short-lived tokens, scalable installation limits, and webhooks. OAuth Apps are simpler user-authorized integrations and their normal tokens are long-lived. [GitHub: GitHub Apps versus OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
- GitHub says to anchor users to the durable numeric `id`, never to mutable login, email, or organization slug. [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#use-the-durable-unique-id-to-store-the-user)

### Recommendation / inference

Start with a **GitHub OAuth App** because this feature only authenticates a person and all planned network data is public. It avoids installation concepts, private keys, webhooks, and repository permissions. Move to a GitHub App only if a later product decision needs fine-grained private organization/repository data or app installation behavior.

Use only Better Auth's required `user:email` scope, never `user`, `repo`, `read:org`, or `user:follow`. If avoiding private-email access is important, prototype `disableDefaultScope` plus a `.invalid` placeholder derived from GitHub's stable numeric ID before adopting it: Better Auth's OAuth guide documents the fallback, but its GitHub-specific guide still states that `user:email` is required. That conflict makes the no-scope variant something to verify in an integration test, not the baseline architecture.

The local Better Auth user ID should own saved application data. Retain the provider account's immutable GitHub numeric ID as the identity link to tracked profiles; do not join member data to the existing login-derived `entities.id` alone, because GitHub logins can change.

## OAuth token retention

### Documented facts

- Better Auth's account schema can store provider access/refresh tokens and scopes. OAuth token encryption is available but is **off by default**. [Better Auth: database schema](https://better-auth.com/docs/concepts/database) [Better Auth: options](https://better-auth.com/docs/reference/options)
- Ordinary GitHub OAuth App tokens are long-lived unless revoked or unused for a year. GitHub App user tokens can be short-lived. GitHub recommends encrypting retained tokens on the backend and revoking tokens that are no longer needed. [Better Auth: GitHub](https://better-auth.com/docs/authentication/github) [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)

### Recommendation / inference

The public followers, following, and organization leaderboards do not need a user's OAuth token. Do not treat login as extra GitHub crawling quota, and do not pass a user's token into background ingestion jobs.

Prefer discarding token material after Better Auth has fetched and verified the profile. Better Auth does not document a single `storeOAuthToken: false` option, so this needs a small, tested account create/update hook or post-callback cleanup. Until that behavior is verified, set `account.encryptOAuthTokens: true`, restrict database access, and never return token fields to the client. Token minimization should be an explicit acceptance test because Better Auth's default account schema retains the token unencrypted.

## Postgres schema and migrations

### Documented facts

Better Auth's core relational schema includes user, session, account, and verification records. Its CLI can generate a Drizzle schema, but Drizzle-adapter migrations must be generated/applied with Drizzle rather than Better Auth's direct `migrate` command. The adapter can use PostgreSQL and supports a dedicated PostgreSQL schema namespace. [Better Auth: database](https://better-auth.com/docs/concepts/database) [Better Auth: Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)

### Recommendation / inference

- Generate the auth schema from the pinned Better Auth version, include it in the schema object passed to both Drizzle and `drizzleAdapter`, then produce and review a normal checked-in `drizzle-kit` migration.
- Prefer an `auth` PostgreSQL schema or explicit `auth_*` table names to keep identity tables distinct from public tracked entities. Either is supported; a namespace gives the clearest boundary.
- Add an optional rate-limit table if shared rate limiting is selected. Product-owned tables (saved cohorts/preferences) should reference the local auth user ID and remain outside Better Auth's generated schema.
- Treat auth migrations as required production migrations. Unlike the public cache, authentication cannot fall back to memory when `DATABASE_URL` is absent.

There is a deployment gap to resolve before implementation: the current runtime image copies only `.output`, so it lacks `pnpm`, Drizzle Kit, source schema, and the checked-in migration files. Coolify documents that pre-deployment commands run in the current container and post-deployment commands in the new container; neither can run the existing `pnpm db:migrate` in today's image. [Coolify: Dockerfile deployments](https://coolify.io/docs/applications/build-packs/dockerfile)

For the first additive auth migration, the safest available sequence is to apply the reviewed migration from a trusted admin/CI environment before deploying code that requires it. A durable follow-up is to bundle a small migration entry point plus migrations into the runtime image and execute it as a one-off deployment job with mutual exclusion; do not run migrations opportunistically in every web process at startup.

## Coolify, reverse proxy, and base URL

### Documented facts

- Better Auth recommends setting a static `baseURL` or `BETTER_AUTH_URL`; request inference is not recommended. Forwarded host/protocol headers are ignored unless `advanced.trustedProxyHeaders` is explicitly enabled. [Better Auth: options](https://better-auth.com/docs/reference/options)
- Coolify assigns HTTPS domains through Traefik or Caddy and routes the public domain to the configured container port. It can provide variables only at runtime; runtime-only values do not enter image build layers. [Coolify: domains](https://coolify.io/docs/knowledge-base/domains) [Coolify: environment variables](https://coolify.io/docs/knowledge-base/environment-variables)

### Recommendation / inference

For the single production domain, configure `BETTER_AUTH_URL=https://commit-history.com` and `trustedOrigins: ["https://commit-history.com"]`. This avoids depending on proxy header reconstruction, so `advanced.trustedProxyHeaders` is not needed. Keep `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET` (or versioned secrets), and `DATABASE_URL` as Coolify runtime-only variables. The browser should call relative `/api/auth/*` URLs.

If preview/custom domains become a requirement, switch deliberately to Better Auth's dynamic `baseURL.allowedHosts` configuration and validate Coolify's `X-Forwarded-Host`/`X-Forwarded-Proto` behavior before enabling trusted proxy headers. Do not accept arbitrary hosts or origins.

## Development and production callbacks

Better Auth's default callback path is `/api/auth/callback/github`. Register exact callbacks:

- local: `http://127.0.0.1:3000/api/auth/callback/github` (or `localhost` if the local app/browser setup requires it)
- production: `https://commit-history.com/api/auth/callback/github`

Set `BETTER_AUTH_URL` to the matching origin in each environment. GitHub now allows up to ten callback URLs on an OAuth App, so one registration can contain both. Exact matching is preferable; GitHub warns that callback wildcard matching can leak authorization codes to an attacker-controlled subdomain/path and recommends disabling it when unnecessary. [GitHub: creating an OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) [GitHub: authorizing OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

Using separate GitHub registrations for development and production gives stronger credential and consent-screen isolation, but it is not technically required. One registration with two exact callbacks is sufficient for this project's current environments.

## Implementation acceptance checks

Before calling the approach production-ready, verify:

1. GitHub is the only enabled sign-in provider; email/password and account-linking UI are absent.
2. The authorization request contains only the approved scope and includes state plus PKCE `S256`.
3. The callback rejects missing/mismatched state, reused codes, unapproved callback origins, and callbacks without the short-lived state cookie.
4. Production sets a host-only `HttpOnly`, `Secure`, `SameSite=Lax` session cookie; local HTTP works without accidentally forcing the production cookie configuration.
5. Session lookup, sign-out, expiry, and server-side revocation work across a process restart.
6. Direct unauthenticated calls to every account-owned server function fail even when the page route guard is bypassed.
7. OAuth token columns are encrypted or empty according to the final retention decision, and tokens never reach client responses, logs, queue jobs, or analytics.
8. A GitHub login rename still resolves to the same member via GitHub's numeric ID.
9. The production migration runs before auth traffic and a missing database/auth secret fails closed with a clear startup/configuration error.
10. The Coolify proxy produces a production callback URL with `https://commit-history.com`, never the internal container host or `http://...:3000`.

## Decision-relevant conclusion

The route is implementation-ready at the library boundary: Better Auth + GitHub OAuth App + Drizzle/Postgres sessions, mounted in a TanStack Start server route with an explicit production base URL. The next decisions are narrow: whether to accept `user:email` or validate a no-scope placeholder-email variant, how to guarantee OAuth-token deletion, and which controlled mechanism applies checked-in migrations in Coolify.
