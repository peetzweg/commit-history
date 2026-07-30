import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import { entities, orgMembers } from "#/lib/db/schema";
import type { OrgMember, OrgMemberTotals } from "#/lib/github";
import { createJobLock, LOCK_KEYS } from "#/lib/job-runner";
import {
	type OrgBackfillStore,
	type OrgBackfillTarget,
	orgEntityId,
	userEntityId,
} from "#/lib/org-backfill";

/** Row batch size for the member stub / pending-row inserts. */
const CHUNK_ROWS = 100;

export function createOrgBackfillStore(database: DB): OrgBackfillStore {
	const lock = createJobLock(
		database,
		...LOCK_KEYS.orgBackfill,
		"org-backfill",
	);

	return {
		tryLock: lock.tryLock,
		releaseLock: lock.releaseLock,

		async unfilledOrgs(limit) {
			const rows = await database
				.select({
					id: entities.id,
					login: entities.login,
					memberCount: entities.memberCount,
				})
				.from(entities)
				.where(and(eq(entities.kind, "org"), isNull(entities.builtAt)))
				.orderBy(sql`${entities.memberCount} asc nulls last`, asc(entities.id))
				.limit(limit);
			return rows.map((row) => toTarget(row, "unfilled"));
		},

		async staleOrgs(builtBefore, limit) {
			const rows = await database
				.select({
					id: entities.id,
					login: entities.login,
					memberCount: entities.memberCount,
				})
				.from(entities)
				.where(
					and(
						eq(entities.kind, "org"),
						isNotNull(entities.builtAt),
						lt(entities.builtAt, builtBefore),
					),
				)
				.orderBy(asc(entities.builtAt), asc(entities.id))
				.limit(limit);
			return rows.map((row) => toTarget(row, "stale"));
		},

		async countUnfilled() {
			const [row] = await database
				.select({ n: sql<number>`count(*)` })
				.from(entities)
				.where(and(eq(entities.kind, "org"), isNull(entities.builtAt)));
			return Number(row?.n ?? 0);
		},

		async upsertOrgProfile(profile, fetchedAt) {
			const id = orgEntityId(profile.login);
			// `builtAt` is deliberately absent: only a completed roll-up may stamp it.
			const columns = {
				login: profile.login,
				name: profile.name,
				avatarUrl: profile.avatarUrl,
				htmlUrl: profile.htmlUrl,
				createdAt: new Date(profile.createdAt),
				bio: profile.description,
				location: profile.location,
				websiteUrl: profile.websiteUrl,
				twitterUsername: profile.twitterUsername,
				publicRepos: profile.publicRepos,
				isVerified: profile.isVerified,
				githubNodeId: profile.nodeId,
				memberCount: profile.memberCount,
				lastFetched: fetchedAt,
			};
			await database
				.insert(entities)
				.values({ id, kind: "org", ...columns })
				.onConflictDoUpdate({ target: entities.id, set: columns });
			return id;
		},

		async recordMembers(orgId, members) {
			for (let i = 0; i < members.length; i += CHUNK_ROWS) {
				const chunk = members.slice(i, i + CHUNK_ROWS);
				// User stubs are the FK target for org_members. onConflictDoNothing so a real user
				// row (with totals, months, everything) is never clobbered by a stub.
				await database
					.insert(entities)
					.values(chunk.map(memberStub))
					.onConflictDoNothing();
				await database
					.insert(orgMembers)
					.values(
						chunk.map((m) => ({
							orgId,
							memberId: userEntityId(m.login),
							role: m.role,
							source: "public_member",
						})),
					)
					.onConflictDoNothing();
			}
		},

		async fetchedMemberIds(orgId) {
			const rows = await database
				.select({ memberId: orgMembers.memberId })
				.from(orgMembers)
				.where(
					and(eq(orgMembers.orgId, orgId), isNotNull(orgMembers.lastFetched)),
				);
			return new Set(rows.map((r) => r.memberId));
		},

		async saveMemberTotals(orgId, memberId, totals, fetchedAt) {
			await database
				.update(orgMembers)
				.set({ ...totals, lastFetched: fetchedAt })
				.where(
					and(eq(orgMembers.orgId, orgId), eq(orgMembers.memberId, memberId)),
				);
		},

		async rollUpOrg(orgId, fetchedAt) {
			// Departed members' rows stay frozen in the sum, same as #97.
			const [sums] = await database
				.select({
					commits: sql<number>`coalesce(sum(${orgMembers.commits}), 0)`,
					pullRequests: sql<number>`coalesce(sum(${orgMembers.pullRequests}), 0)`,
					reviews: sql<number>`coalesce(sum(${orgMembers.reviews}), 0)`,
					issues: sql<number>`coalesce(sum(${orgMembers.issues}), 0)`,
				})
				.from(orgMembers)
				.where(eq(orgMembers.orgId, orgId));
			const totals: OrgMemberTotals = {
				commits: Number(sums?.commits ?? 0),
				pullRequests: Number(sums?.pullRequests ?? 0),
				reviews: Number(sums?.reviews ?? 0),
				issues: Number(sums?.issues ?? 0),
			};
			await database
				.update(entities)
				.set({
					totalCommits: totals.commits,
					totalPullRequests: totals.pullRequests,
					totalReviews: totals.reviews,
					totalIssues: totals.issues,
					builtAt: fetchedAt,
					lastFetched: fetchedAt,
				})
				.where(eq(entities.id, orgId));
			return totals;
		},
	};
}

function toTarget(
	row: { id: string; login: string | null; memberCount: number | null },
	source: OrgBackfillTarget["source"],
): OrgBackfillTarget {
	return {
		id: row.id,
		// Every org row is created from a profile fetch, so `login` is populated in practice; fall
		// back to the id's suffix rather than skipping the org outright.
		login: row.login ?? row.id.replace(/^org:/, ""),
		memberCount: row.memberCount,
		source,
	};
}

function memberStub(member: OrgMember) {
	return {
		id: userEntityId(member.login),
		kind: "user",
		login: member.login,
		name: member.name,
		avatarUrl: member.avatarUrl,
		htmlUrl: `https://github.com/${member.login}`,
		createdAt: new Date(member.createdAt),
	};
}
