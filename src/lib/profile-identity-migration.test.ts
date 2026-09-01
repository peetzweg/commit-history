import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("profile identity migration", () => {
	const migration = readFileSync(
		new URL("../../drizzle/0009_profile_identity.sql", import.meta.url),
		"utf8",
	);

	it("preflights duplicate user node ids before adding the invariant", () => {
		const duplicateCheck = migration.indexOf("HAVING count(*) > 1");
		const uniqueIndex = migration.indexOf("CREATE UNIQUE INDEX");

		expect(duplicateCheck).toBeGreaterThanOrEqual(0);
		expect(uniqueIndex).toBeGreaterThan(duplicateCheck);
		expect(migration).toContain("Duplicate GitHub user node ids");
	});

	it("scopes node-id uniqueness to user rows so organization renames are unaffected", () => {
		expect(migration).toContain("WHERE \"kind\" = 'user'");
	});
});
