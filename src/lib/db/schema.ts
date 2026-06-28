import {
	boolean,
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
	},
	(t) => [primaryKey({ columns: [t.entityId, t.month] })],
);

/**
 * Ad inventory — one row per purchasable slot, inserted between leaderboard ranks as a spacer
 * (it never replaces a real user). `afterRank` is both the primary key and the position: the slot
 * renders right after that rank, so the default set is 5, 25, 50, 75, 100 — pricier the higher up.
 *
 * Prices and per-slot Stripe Payment Links live here (not in code) so a 7-day pricing experiment
 * is a single SQL UPDATE with no redeploy.
 */
export const adSlots = pgTable("ad_slots", {
	afterRank: integer("after_rank").primaryKey(), // slot renders after this leaderboard rank
	tier: text("tier").notNull(), // display label, e.g. "Prime" | "Premium" | "Standard" | "Basic"
	priceWeekly: integer("price_weekly").notNull(), // USD per 7 days (whole dollars), shown on the CTA
	checkoutUrl: text("checkout_url"), // this slot's Stripe Payment Link; null = CTA hidden
	enabled: boolean("enabled").notNull().default(true),
});

/**
 * A sold sponsorship — who bought which slot, for which window, and the creative that renders.
 *
 * Path A (current): rows are created/edited by hand after a Stripe Payment Link purchase, and
 * `status` is flipped to 'active' once the creative is reviewed. Path B (later) has the Stripe
 * webhook write these rows directly (status 'pending_review' on `checkout.session.completed`) —
 * same table, no migration churn.
 *
 * A sponsor shows only when `status = 'active'` and now is within [activeFrom, activeUntil). For
 * the 7-day model set `activeUntil = activeFrom + 7 days`; null = runs until pulled by hand.
 */
export const sponsorships = pgTable("sponsorships", {
	id: text("id").primaryKey(), // e.g. a Stripe subscription id, or a manual slug for Path A
	afterRank: integer("after_rank")
		.notNull()
		.references(() => adSlots.afterRank), // which slot this sponsorship occupies
	status: text("status").notNull().default("pending_review"), // pending_review | active | rejected | cancelled
	// Creative — what renders in the ad row.
	label: text("label").notNull(), // shown as the row's main text (advertiser name / tagline)
	imageUrl: text("image_url"), // optional logo/avatar (rendered like a user avatar)
	linkUrl: text("link_url").notNull(), // where the row links to (rel="sponsored nofollow")
	// Booking window. For 7-day terms set activeUntil = activeFrom + 7d; null = until pulled.
	activeFrom: timestamp("active_from", { withTimezone: true })
		.notNull()
		.defaultNow(),
	activeUntil: timestamp("active_until", { withTimezone: true }),
	// Stripe linkage (nullable for manual Path A rows).
	stripeCustomerId: text("stripe_customer_id"),
	stripeSubscriptionId: text("stripe_subscription_id"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

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
