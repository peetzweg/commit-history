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
export const entities = pgTable("entities", {
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
});

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
	],
);

/**
 * Per-month resolution of org_members — one row per (org, member, month), written by the
 * refresh-orgs worker (the request path stores lifetime totals only). Summed across members
 * per month these produce the org's own monthly_commits rows (the company chart); per-row
 * they enable member-level charts and precise incremental refresh later.
 */
export const orgMemberMonthly = pgTable(
	"org_member_monthly",
	{
		orgId: text("org_id")
			.notNull()
			.references(() => entities.id),
		memberId: text("member_id")
			.notNull()
			.references(() => entities.id),
		month: date("month").notNull(), // YYYY-MM-01
		commits: integer("commits").notNull().default(0),
		pullRequests: integer("pull_requests").notNull().default(0),
		reviews: integer("reviews").notNull().default(0),
		issues: integer("issues").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.orgId, t.memberId, t.month] })],
);

/** Every search — powers "recent lookups" and the all-time leaderboard. */
export const lookups = pgTable("lookups", {
	id: serial("id").primaryKey(),
	entityId: text("entity_id")
		.notNull()
		.references(() => entities.id),
	searchedAt: timestamp("searched_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});
