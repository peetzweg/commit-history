import { sql } from "drizzle-orm";
import {
	boolean,
	date,
	index,
	integer,
	pgTable,
	primaryKey,
	serial,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

/**
 * A tracked entity — currently a GitHub user; `kind` leaves room for orgs/repos later.
 * `id` is namespaced so the same login can't collide across kinds: e.g. "user:torvalds".
 */
export const entities = pgTable(
	"entities",
	{
		id: text("id").primaryKey(),
		kind: text("kind").notNull(), // 'user' | 'org' | 'repo'
		login: text("login").notNull(),
		name: text("name"),
		avatarUrl: text("avatar_url"),
		htmlUrl: text("html_url"),
		createdAt: timestamp("created_at", { withTimezone: true }), // defines the window start
		totalCommits: integer("total_commits").notNull().default(0), // public commits
		totalRestricted: integer("total_restricted").notNull().default(0), // private contributions
		// Additional public contribution-type lifetime totals. Nullable so null = "not yet backfilled
		// with the new types" (drives the backfill script's default mode), distinct from a real 0 —
		// same rationale as the profile-metadata columns below.
		totalIssues: integer("total_issues"), // public issues opened
		totalPullRequests: integer("total_pull_requests"), // public PRs opened
		totalReviews: integer("total_reviews"), // public PR reviews
		totalRepos: integer("total_repos"), // public repositories created
		// Profile metadata — mutable, refreshed on the trailing-refresh path (see cache.ts). All
		// nullable so an unknown value (older row, fetch failure) stays distinguishable from a real 0.
		followers: integer("followers"),
		following: integer("following"),
		publicRepos: integer("public_repos"),
		bio: text("bio"),
		company: text("company"),
		location: text("location"),
		websiteUrl: text("website_url"),
		twitterUsername: text("twitter_username"),
		// Org-only metadata (null on user rows — same "unknown vs not applicable" convention).
		isVerified: boolean("is_verified"), // org domain-verified badge
		githubNodeId: text("github_node_id"), // GraphQL node id — keys contributionsCollection(organizationID:) without a profile round-trip
		memberCount: integer("member_count"), // membersWithRole.totalCount (includes private members) — display only
		lastFetched: timestamp("last_fetched", { withTimezone: true }), // staleness / trailing refresh; also "profile last updated"
		builtAt: timestamp("built_at", { withTimezone: true }), // initial build completed; null = months still being fetched incrementally
		// Moderation: null = active. When set, the entity is hidden from the leaderboard and
		// "recently looked up" (still directly viewable, with an under-review notice) until cleared.
		suspendedAt: timestamp("suspended_at", { withTimezone: true }),
		suspendedReason: text("suspended_reason"), // internal note — never shown publicly
	},
	(t) => {
		// The user leaderboard (queryLeaderboard) and per-metric rank counts (metricRankFor) both
		// scope to this population, then sort/range-scan a single metric column. One partial index
		// per ranked metric turns each of those from a full-table scan into a short index scan.
		// Column order (`<metric> DESC NULLS LAST, id ASC`) mirrors the board's ORDER BY exactly —
		// including null placement, which Postgres pathkey matching is strict about.
		const activeUsers = sql`${t.kind} = 'user' and ${t.suspendedAt} is null and ${t.builtAt} is not null`;
		return [
			index("entities_rank_commits_idx")
				.on(t.totalCommits.desc().nullsLast(), t.id.asc())
				.where(activeUsers),
			index("entities_rank_prs_idx")
				.on(t.totalPullRequests.desc().nullsLast(), t.id.asc())
				.where(activeUsers),
			index("entities_rank_issues_idx")
				.on(t.totalIssues.desc().nullsLast(), t.id.asc())
				.where(activeUsers),
			index("entities_rank_reviews_idx")
				.on(t.totalReviews.desc().nullsLast(), t.id.asc())
				.where(activeUsers),
			index("entities_rank_repos_idx")
				.on(t.totalRepos.desc().nullsLast(), t.id.asc())
				.where(activeUsers),
			index("entities_rank_private_idx")
				.on(t.totalRestricted.desc().nullsLast(), t.id.asc())
				.where(activeUsers),
			index("entities_rank_followers_idx")
				.on(t.followers.desc().nullsLast(), t.id.asc())
				.where(activeUsers),
			// The `total` board/rank orders by this summed expression (plain DESC — it can never be
			// null, every nullable term is coalesced). Must textually match commit-history.ts.
			index("entities_rank_total_idx")
				.on(
					sql`(${t.totalCommits} + coalesce(${t.totalIssues}, 0) + coalesce(${t.totalPullRequests}, 0) + coalesce(${t.totalReviews}, 0) + coalesce(${t.totalRepos}, 0) + ${t.totalRestricted}) desc`,
					t.id.asc(),
				)
				.where(activeUsers),
			// Org leaderboard (queryOrgLeaderboard) — same shape, org population. nullsFirst because
			// that query orders by plain `desc(...)` (Postgres DESC default), and index usability
			// depends on the null placement matching the ORDER BY even for non-null columns.
			index("entities_org_rank_commits_idx")
				.on(t.totalCommits.desc().nullsFirst(), t.id.asc())
				.where(
					sql`${t.kind} = 'org' and ${t.suspendedAt} is null and ${t.builtAt} is not null`,
				),
		];
	},
);

/** Per-month commit counts. Past months are immutable; only the current month changes. */
export const monthlyCommits = pgTable(
	"monthly_commits",
	{
		entityId: text("entity_id")
			.notNull()
			.references(() => entities.id),
		month: date("month").notNull(), // YYYY-MM-01
		commits: integer("commits").notNull(), // public commits
		restricted: integer("restricted").notNull().default(0), // private contributions
		// Additional public contribution types for the month. Default 0 (a fresh migration leaves
		// historical rows at 0 until the backfill script or a full rebuild fills real values).
		issues: integer("issues").notNull().default(0), // public issues opened
		pullRequests: integer("pull_requests").notNull().default(0), // public PRs opened
		reviews: integer("reviews").notNull().default(0), // public PR reviews
		repos: integer("repos").notNull().default(0), // public repositories created
	},
	(t) => [primaryKey({ columns: [t.entityId, t.month] })],
);

/**
 * Org membership + each member's lifetime contributions *to that org* (org-scoped
 * `contributionsCollection(organizationID: …)` sums — a different number from the member's
 * global totals on `entities`). Summed per org these produce the org row's entity totals;
 * per-row they power the future within-org member leaderboard.
 */
export const orgMembers = pgTable(
	"org_members",
	{
		orgId: text("org_id")
			.notNull()
			.references(() => entities.id), // 'org:<login>'
		memberId: text("member_id")
			.notNull()
			.references(() => entities.id), // 'user:<login>'
		role: text("role"), // 'MEMBER' | 'ADMIN' (membersWithRole edge role)
		source: text("source").notNull().default("public_member"), // 'public_member' | 'tracked_attribution'
		commits: integer("commits").notNull().default(0),
		pullRequests: integer("pull_requests").notNull().default(0),
		reviews: integer("reviews").notNull().default(0),
		issues: integer("issues").notNull().default(0),
		// null = member enumerated but contributions not yet fetched — the org build's resume marker.
		lastFetched: timestamp("last_fetched", { withTimezone: true }),
	},
	(t) => [
		primaryKey({ columns: [t.orgId, t.memberId] }),
		// Reverse lookup: "which orgs did this user contribute to" on personal profiles.
		index("org_members_member_idx").on(t.memberId),
		// Within-org member leaderboard (queryOrgMembers): fetched members of one org ordered by
		// commits. Matches that query's ORDER BY so big orgs skip the per-request sort; partial on
		// the same `last_fetched is not null` predicate so pending rows never bloat it.
		// nullsFirst: matches that query's plain `desc(...)` ordering (see entities' org index note).
		index("org_members_org_commits_idx")
			.on(t.orgId.asc(), t.commits.desc().nullsFirst(), t.memberId.asc())
			.where(sql`${t.lastFetched} is not null`),
	],
);

/** Every search — powers "recent lookups" and the all-time leaderboard. */
export const lookups = pgTable(
	"lookups",
	{
		id: serial("id").primaryKey(),
		entityId: text("entity_id")
			.notNull()
			.references(() => entities.id),
		searchedAt: timestamp("searched_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		// The "recently looked up" strip (queryRecent) reads the newest slice of this append-only
		// table on every poll; this keeps that a bounded index scan no matter how large the full
		// search history grows.
		// nullsFirst: matches queryRecent's plain `desc(...)` ordering (see entities' org index note).
		index("lookups_searched_at_idx").on(t.searchedAt.desc().nullsFirst()),
	],
);
