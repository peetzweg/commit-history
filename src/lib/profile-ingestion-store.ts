import { and, eq, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import { entities, monthlyCommits } from "#/lib/db/schema";
import type { CommitHistory, MonthlyCount, Profile } from "#/lib/github";
import { saveProfileIdentity } from "#/lib/profile-identity";
import {
	isStoredProfileMonthComplete,
	type ProfileIngestionStore,
	type StoredProfile,
} from "#/lib/profile-ingestion-engine";

type EntityRow = typeof entities.$inferSelect;

export function createProfileIngestionStore(
	database: DB,
): ProfileIngestionStore {
	return {
		async findProfile(target) {
			if (target.githubNodeId) {
				const row = await findByNodeId(database, target.githubNodeId);
				return row ? storedProfile(row) : undefined;
			}
			const rows = await findByLogin(database, target.login);
			// Multiple rows can legitimately retain a recycled login. GitHub must resolve its
			// current owner before this module chooses which entity's months to load.
			return rows.length === 1 ? storedProfile(rows[0]) : undefined;
		},

		async saveProfile(profile) {
			const identity = await saveProfileIdentity(database, profile);
			return storedProfile(identity.row, profile);
		},

		async storedMonths(entityId) {
			const rows = await database
				.select()
				.from(monthlyCommits)
				.where(eq(monthlyCommits.entityId, entityId));
			return rows.map((row) => ({
				month: row.month,
				counts: countsFromRow(row),
				fetchedAt: row.fetchedAt,
			}));
		},

		async saveMonths(entityId, months, fetchedAt) {
			if (months.length === 0) return;
			await database
				.insert(monthlyCommits)
				.values(
					months.map(({ month, counts }) => ({
						entityId,
						month,
						...counts,
						fetchedAt,
					})),
				)
				.onConflictDoUpdate({
					target: [monthlyCommits.entityId, monthlyCommits.month],
					set: {
						commits: sql`excluded.commits`,
						restricted: sql`excluded.restricted`,
						issues: sql`excluded.issues`,
						pullRequests: sql`excluded.pull_requests`,
						reviews: sql`excluded.reviews`,
						repos: sql`excluded.repos`,
						fetchedAt: sql`excluded.fetched_at`,
					},
				});
		},

		async markComplete(entityId, history, expectedMonths, at) {
			await database.transaction(async (tx) => {
				const [profile] = await tx
					.select({ builtAt: entities.builtAt })
					.from(entities)
					.where(eq(entities.id, entityId))
					.limit(1);
				if (!profile) {
					throw new Error(`Profile entity ${entityId} disappeared.`);
				}
				const rows = await tx
					.select({
						month: monthlyCommits.month,
						fetchedAt: monthlyCommits.fetchedAt,
					})
					.from(monthlyCommits)
					.where(eq(monthlyCommits.entityId, entityId));
				const durable = new Set(
					rows
						.filter((row) => isStoredProfileMonthComplete(row, profile.builtAt))
						.map((row) => row.month),
				);
				const missing = expectedMonths.filter((month) => !durable.has(month));
				if (missing.length > 0) {
					throw new Error(
						`Cannot complete ${history.user.login}; ${missing.length} months are not durable.`,
					);
				}
				const [updated] = await tx
					.update(entities)
					.set(completedProfileValues(history, at))
					.where(eq(entities.id, entityId))
					.returning({ id: entities.id });
				if (!updated)
					throw new Error(`Profile entity ${entityId} disappeared.`);
			});
		},

		async markUnreachable(entityId, at) {
			await database
				.update(entities)
				.set({ unreachableAt: at })
				.where(and(eq(entities.id, entityId), eq(entities.kind, "user")));
		},
	};
}

async function findByNodeId(
	database: DB,
	nodeId: string,
): Promise<EntityRow | undefined> {
	const [row] = await database
		.select()
		.from(entities)
		.where(and(eq(entities.kind, "user"), eq(entities.githubNodeId, nodeId)))
		.limit(1);
	return row;
}

async function findByLogin(database: DB, login: string): Promise<EntityRow[]> {
	return database
		.select()
		.from(entities)
		.where(
			and(
				eq(entities.kind, "user"),
				sql`lower(${entities.login}) = lower(${login.trim()})`,
			),
		)
		.limit(2);
}

function storedProfile(row: EntityRow, profile?: Profile): StoredProfile {
	return {
		entityId: row.id,
		profile: profile ?? profileFromRow(row),
		builtAt: row.builtAt,
		lastFetched: row.lastFetched,
	};
}

function profileFromRow(row: EntityRow): Profile {
	if (!row.createdAt) {
		throw new Error(`Stored profile ${row.id} has no creation date.`);
	}
	return {
		nodeId: row.githubNodeId ?? "",
		login: row.login,
		name: row.name,
		avatarUrl: row.avatarUrl ?? "",
		createdAt: row.createdAt.toISOString(),
		bio: row.bio,
		company: row.company,
		location: row.location,
		websiteUrl: row.websiteUrl,
		twitterUsername: row.twitterUsername,
		followers: row.followers ?? 0,
		following: row.following ?? 0,
		publicRepos: row.publicRepos ?? 0,
	};
}

function completedProfileValues(history: CommitHistory, at: Date) {
	return {
		totalCommits: history.total,
		totalRestricted: history.totalRestricted,
		totalIssues: history.totalIssues,
		totalPullRequests: history.totalPullRequests,
		totalReviews: history.totalReviews,
		totalRepos: history.totalRepos,
		lastFetched: at,
		builtAt: sql`coalesce(${entities.builtAt}, ${at.toISOString()}::timestamptz)`,
	};
}

function countsFromRow(row: typeof monthlyCommits.$inferSelect): MonthlyCount {
	return {
		commits: row.commits,
		restricted: row.restricted,
		issues: row.issues,
		pullRequests: row.pullRequests,
		reviews: row.reviews,
		repos: row.repos,
	};
}
