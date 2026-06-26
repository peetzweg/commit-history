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
	lastFetched: timestamp("last_fetched", { withTimezone: true }), // staleness / trailing refresh
	builtAt: timestamp("built_at", { withTimezone: true }), // last full rebuild (catches backfills)
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
