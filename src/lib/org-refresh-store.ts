import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "#/lib/db";
import { entities, orgMembers } from "#/lib/db/schema";
import type { OrgMember } from "#/lib/github";
import { createJobLock, LOCK_KEYS } from "#/lib/job-runner";
import {
	type MemberWork,
	type OrgRefreshStore,
	orgEntityId,
	userEntityId,
} from "#/lib/org-refresh";

/** Row batch size for the member stub / membership-row inserts. */
const CHUNK_ROWS = 100;

export function createOrgRefreshStore(database: DB): OrgRefreshStore {
	const lock = createJobLock(database, ...LOCK_KEYS.orgRefresh, "org-refresh");

	return {
		tryLock: lock.tryLock,
		releaseLock: lock.releaseLock,

		async orgsNeedingEnumeration(since, limit) {
			const rows = await database
				.select({ id: entities.id, login: entities.login })
				.from(entities)
				.where(
					and(
						eq(entities.kind, "org"),
						isNull(entities.suspendedAt),
						isNull(entities.unreachableAt),
						or(
							isNull(entities.membersEnumeratedAt),
							lt(entities.membersEnumeratedAt, since),
						),
					),
				)
				// Nulls first: never enumerated means the request path recorded the org and refused to
				// build it, so it has no membership at all yet.
				.orderBy(
					sql`${entities.membersEnumeratedAt} asc nulls first`,
					asc(entities.id),
				)
				.limit(limit);
			return rows.map((row) => ({
				id: row.id,
				login: row.login ?? row.id.replace(/^org:/, ""),
			}));
		},

		async upsertOrgProfile(profile, fetchedAt) {
			const id = orgEntityId(profile.login);
			// `builtAt` and `membersEnumeratedAt` are deliberately absent: only a completed roll-up
			// may stamp the first, only `recordMembers` the second.
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

		async recordMembers(orgId, members, enumeratedAt) {
			let discovered = 0;
			for (let i = 0; i < members.length; i += CHUNK_ROWS) {
				const chunk = members.slice(i, i + CHUNK_ROWS);
				// User stubs are the FK target for org_members. onConflictDoNothing so a real user row
				// (with totals, months, everything) is never clobbered by a stub.
				await database
					.insert(entities)
					.values(chunk.map(memberStub))
					.onConflictDoNothing();
				// Also DoNothing, which is what makes re-enumeration additive: an existing member keeps
				// its totals and its `lastFetched`, so re-reading a membership never resets progress.
				// `returning()` yields only the rows actually inserted — the joiners.
				const inserted = await database
					.insert(orgMembers)
					.values(
						chunk.map((m) => ({
							orgId,
							memberId: userEntityId(m.login),
							role: m.role,
							source: "public_member",
						})),
					)
					.onConflictDoNothing()
					.returning({ memberId: orgMembers.memberId });
				discovered += inserted.length;
			}
			await database
				.update(entities)
				.set({ membersEnumeratedAt: enumeratedAt })
				.where(eq(entities.id, orgId));
			return discovered;
		},

		async memberQueue({ staleBefore, limit, logins }) {
			// Round-robin across orgs. `row_number()` partitioned by (org, never-fetched) ranks each
			// org's due members independently, so ordering by that rank takes every org's stalest
			// member before anyone's second-stalest — no org can monopolise a run, however large.
			//
			// Partitioning on `last_fetched is null` as well keeps the two tiers from interfering:
			// without it, an org with never-fetched members would have its stale members pushed to
			// artificially high ranks and refreshed later than everyone else's.
			const rows = await database.execute<{
				org_id: string;
				org_login: string | null;
				org_node_id: string;
				org_created_at: Date | string;
				member_id: string;
				member_login: string | null;
				member_created_at: Date | string | null;
			}>(sql`
				select org_id, org_login, org_node_id, org_created_at,
				       member_id, member_login, member_created_at
				from (
					select om.org_id,
					       o.login as org_login,
					       o.github_node_id as org_node_id,
					       o.created_at as org_created_at,
					       om.member_id,
					       u.login as member_login,
					       u.created_at as member_created_at,
					       (om.last_fetched is null) as never_fetched,
					       row_number() over (
					         partition by om.org_id, (om.last_fetched is null)
					         order by om.last_fetched asc nulls first, om.member_id
					       ) as rn
					from ${orgMembers} om
					join ${entities} o on o.id = om.org_id
					join ${entities} u on u.id = om.member_id
					where (om.last_fetched is null or om.last_fetched < ${staleBefore.toISOString()}::timestamptz)
					  and o.github_node_id is not null
					  and o.created_at is not null
					  and o.suspended_at is null
					  and u.suspended_at is null
					  and u.unreachable_at is null
					  ${logins ? sql`and om.org_id in ${orgIdList(logins)}` : sql``}
				) q
				-- never_fetched first: an org showing nothing is worse than one showing last month.
				order by never_fetched desc, rn, org_id
				limit ${limit}`);

			return [...rows].map(
				(row): MemberWork => ({
					orgId: row.org_id,
					orgLogin: row.org_login ?? row.org_id.replace(/^org:/, ""),
					orgNodeId: row.org_node_id,
					orgCreatedAt: new Date(row.org_created_at),
					memberId: row.member_id,
					memberLogin: row.member_login ?? row.member_id.replace(/^user:/, ""),
					memberCreatedAt: row.member_created_at
						? new Date(row.member_created_at)
						: null,
				}),
			);
		},

		async countDueMembers(staleBefore) {
			// Must apply exactly the filters `memberQueue` does, or the number never reaches zero and
			// reads as "the job is not converging" when in fact nothing is left that it can fetch.
			const [row] = await database.execute<{ n: number | string }>(sql`
				select count(*) as n
				from ${orgMembers} om
				join ${entities} o on o.id = om.org_id
				join ${entities} u on u.id = om.member_id
				where (om.last_fetched is null or om.last_fetched < ${staleBefore.toISOString()}::timestamptz)
				  and o.github_node_id is not null
				  and o.created_at is not null
				  and o.suspended_at is null
				  and u.suspended_at is null
				  and u.unreachable_at is null`);
			return Number(row?.n ?? 0);
		},

		async saveMemberTotals(orgId, memberId, totals, fetchedAt) {
			await database
				.update(orgMembers)
				.set({ ...totals, lastFetched: fetchedAt })
				.where(
					and(eq(orgMembers.orgId, orgId), eq(orgMembers.memberId, memberId)),
				);
		},

		async rollUpOrgs(orgIds, fetchedAt) {
			if (orgIds.length === 0) return;
			const stamp = fetchedAt.toISOString();
			// One statement for the whole touched set — a per-org round-trip would be hundreds of
			// queries at the end of every run. Departed members' rows stay in the sum, same as #97.
			//
			// `built_at` is stamped only once no member row is still unfetched, preserving its
			// meaning for the request path ("this org's numbers are real"). An org mid-fill keeps
			// whatever it had, so a first-time fill stays invisible until it's complete and a
			// previously-built org never regresses to looking unbuilt.
			await database.execute(sql`
				update ${entities} e
				set total_commits = s.commits,
				    total_pull_requests = s.pull_requests,
				    total_reviews = s.reviews,
				    total_issues = s.issues,
				    last_fetched = ${stamp}::timestamptz,
				    built_at = case when s.pending = 0 then ${stamp}::timestamptz else e.built_at end
				from (
					select om.org_id,
					       coalesce(sum(om.commits), 0) as commits,
					       coalesce(sum(om.pull_requests), 0) as pull_requests,
					       coalesce(sum(om.reviews), 0) as reviews,
					       coalesce(sum(om.issues), 0) as issues,
					       count(*) filter (where om.last_fetched is null) as pending
					from ${orgMembers} om
					where om.org_id in ${orgIdList(orgIds)}
					group by om.org_id
				) s
				where e.id = s.org_id`);
		},
	};
}

/** `in (…)` list of org entity ids, accepting either ids or bare logins. */
function orgIdList(values: string[]) {
	const ids = values.map((v) =>
		v.startsWith("org:") ? v.toLowerCase() : orgEntityId(v),
	);
	return sql`(${sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	)})`;
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
