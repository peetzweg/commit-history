import { and, eq, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import { entities } from "#/lib/db/schema";
import type { Profile } from "#/lib/github";

type EntityRow = typeof entities.$inferSelect;
type DBTransaction = Parameters<Parameters<DB["transaction"]>[0]>[0];

export interface ProfileIdentityCandidate {
	id: string;
	login: string;
	githubNodeId: string | null;
}

export class ProfileIdentityConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProfileIdentityConflictError";
	}
}

type CandidateSet =
	| ProfileIdentityCandidate
	| ProfileIdentityCandidate[]
	| null;

export function resolveProfileIdentity(
	profile: Profile,
	candidates: {
		byNodeId: CandidateSet;
		byCurrentLogin: ProfileIdentityCandidate[];
	},
): { entityId: string; operation: "insert" | "update" } {
	const byNodeId = candidates.byNodeId
		? Array.isArray(candidates.byNodeId)
			? candidates.byNodeId
			: [candidates.byNodeId]
		: [];
	if (byNodeId.length > 1) {
		throw new ProfileIdentityConflictError(
			`GitHub user identity ${profile.nodeId} is duplicated in storage; refusing to choose a profile history.`,
		);
	}
	if (byNodeId[0]) {
		return { entityId: byNodeId[0].id, operation: "update" };
	}

	const legacyCandidates = candidates.byCurrentLogin.filter(
		(candidate) => candidate.githubNodeId == null,
	);
	if (legacyCandidates.length === 1 && candidates.byCurrentLogin.length === 1) {
		return { entityId: legacyCandidates[0].id, operation: "update" };
	}
	if (legacyCandidates.length > 1) {
		throw new ProfileIdentityConflictError(
			`GitHub login "${profile.login}" matches multiple legacy profiles; refusing to combine their histories.`,
		);
	}

	return {
		entityId:
			candidates.byCurrentLogin.length === 0
				? `user:${profile.login.trim().toLowerCase()}`
				: `github-user:${profile.nodeId}`,
		operation: "insert",
	};
}

export interface StoredProfileIdentity {
	entityId: string;
	row: EntityRow;
	created: boolean;
}

/**
 * Resolve and refresh a GitHub user by immutable node id.
 *
 * The requested login is only a mutable locator. A row with that login but a different node id
 * is a previous owner and is never selected. Advisory locks serialize first discovery even before
 * the partial unique index is deployed.
 */
export async function saveProfileIdentity(
	database: DB,
	profile: Profile,
): Promise<StoredProfileIdentity> {
	return database.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext('commit-history-profile-identity'), hashtext(${profile.nodeId}))`,
		);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext('commit-history-profile-login'), hashtext(lower(${profile.login})))`,
		);

		const byNodeId = await tx
			.select()
			.from(entities)
			.where(
				and(
					eq(entities.kind, "user"),
					eq(entities.githubNodeId, profile.nodeId),
				),
			)
			.limit(2);
		const byCurrentLogin = await tx
			.select()
			.from(entities)
			.where(
				and(
					eq(entities.kind, "user"),
					sql`lower(${entities.login}) = lower(${profile.login})`,
				),
			);

		const resolution = resolveProfileIdentity(profile, {
			byNodeId,
			byCurrentLogin,
		});
		if (resolution.operation === "update") {
			return updateProfile(tx, resolution.entityId, profile, false);
		}

		const inserted = await insertProfile(tx, resolution.entityId, profile);
		if (inserted) return inserted;

		// A renamed legacy row can retain the preferred login-derived primary key. It is a
		// different immutable identity, so retry with a node-derived opaque id instead.
		const fallbackId = `github-user:${profile.nodeId}`;
		if (fallbackId !== resolution.entityId) {
			const fallback = await insertProfile(tx, fallbackId, profile);
			if (fallback) return fallback;
		}

		const winner = await tx
			.select()
			.from(entities)
			.where(
				and(
					eq(entities.kind, "user"),
					eq(entities.githubNodeId, profile.nodeId),
				),
			)
			.limit(2);
		if (winner.length !== 1) {
			throw new ProfileIdentityConflictError(
				`Could not assign GitHub user identity ${profile.nodeId} to exactly one stored profile.`,
			);
		}
		return updateProfile(tx, winner[0].id, profile, false);
	});
}

async function insertProfile(
	database: DBTransaction,
	id: string,
	profile: Profile,
): Promise<StoredProfileIdentity | null> {
	const [row] = await database
		.insert(entities)
		.values({
			id,
			kind: "user",
			...profileColumns(profile),
		})
		.onConflictDoNothing()
		.returning();
	return row ? { entityId: row.id, row, created: true } : null;
}

async function updateProfile(
	database: DBTransaction,
	id: string,
	profile: Profile,
	created: boolean,
): Promise<StoredProfileIdentity> {
	const [row] = await database
		.update(entities)
		.set({ ...profileColumns(profile), unreachableAt: null })
		.where(and(eq(entities.id, id), eq(entities.kind, "user")))
		.returning();
	if (!row) {
		throw new ProfileIdentityConflictError(
			`Stored profile ${id} changed while resolving GitHub identity ${profile.nodeId}.`,
		);
	}
	return { entityId: row.id, row, created };
}

function profileColumns(profile: Profile) {
	return {
		login: profile.login,
		githubNodeId: profile.nodeId,
		name: profile.name,
		avatarUrl: profile.avatarUrl,
		htmlUrl: `https://github.com/${profile.login}`,
		createdAt: new Date(profile.createdAt),
		followers: profile.followers,
		following: profile.following,
		publicRepos: profile.publicRepos,
		bio: profile.bio,
		company: profile.company,
		location: profile.location,
		websiteUrl: profile.websiteUrl,
		twitterUsername: profile.twitterUsername,
	};
}
