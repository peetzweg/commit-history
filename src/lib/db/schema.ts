import {
	date,
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
	lastFetched: timestamp("last_fetched", { withTimezone: true }), // staleness / trailing refresh; also "profile last updated"
	builtAt: timestamp("built_at", { withTimezone: true }), // last full rebuild (catches backfills)
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
