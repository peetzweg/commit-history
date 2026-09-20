import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { userNetworkMembers } from "#/lib/profile-network-members";

const migration = readFileSync(
	new URL("../../drizzle/0011_flawless_calypso.sql", import.meta.url),
	"utf8",
);

describe("userNetworkMembers", () => {
	it("excludes organizations from leaderboard progress and pending rows", () => {
		const members = [
			{ login: "person", kind: "user" },
			{ login: "organization", kind: "org" },
		];

		expect(userNetworkMembers(members)).toEqual([
			{ login: "person", kind: "user" },
		]);
	});

	it("fails legacy rows closed and invalidates unclassified snapshots", () => {
		expect(migration).toContain("\"kind\" text DEFAULT 'org' NOT NULL");
		expect(migration).toContain('SET "kind" = "entity"."kind"');
		expect(migration).toContain('SET "enumerated_at" = NULL');
	});
});
