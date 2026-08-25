import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/lib/db", () => ({ db: null }));

import { recordLookup } from "#/lib/cache";

const dialect = new PgDialect();

function sqlText(query: Parameters<PgDialect["sqlToQuery"]>[0]): string {
	return dialect.sqlToQuery(query).sql;
}

describe("recent lookup retention", () => {
	it("serializes the global upsert-and-prune invariant", async () => {
		const operations: string[] = [];
		const execute = vi.fn(async (query) => {
			operations.push(sqlText(query));
		});
		const onConflictDoUpdate = vi.fn(async () => {
			operations.push("upsert");
		});
		const transaction = vi.fn(async (callback) =>
			callback({
				execute,
				insert: () => ({
					values: () => ({ onConflictDoUpdate }),
				}),
			}),
		);

		await recordLookup(
			{ transaction } as never,
			"user:example",
			new Date("2026-08-25T08:00:00Z"),
		);

		expect(operations).toHaveLength(3);
		expect(operations[0]).toContain("pg_advisory_xact_lock");
		expect(operations[1]).toBe("upsert");
		expect(operations[2]).toContain('delete from "lookups"');
	});

	it("never replaces a newer lookup timestamp with an older request", async () => {
		let conflictConfig: { set: { searchedAt: unknown } } | undefined;
		const transaction = vi.fn(async (callback) =>
			callback({
				execute: vi.fn(async () => undefined),
				insert: () => ({
					values: () => ({
						onConflictDoUpdate: vi.fn(async (config) => {
							conflictConfig = config;
						}),
					}),
				}),
			}),
		);

		await recordLookup(
			{ transaction } as never,
			"user:example",
			new Date("2026-08-25T08:00:00Z"),
		);

		expect(conflictConfig).toBeDefined();
		expect(
			sqlText(conflictConfig?.set.searchedAt as Parameters<typeof sqlText>[0]),
		).toContain("greatest(");
	});

	it("blocks legacy writers before migration cleanup begins", () => {
		const migration = readFileSync(
			new URL("../../drizzle/0008_faulty_sabretooth.sql", import.meta.url),
			"utf8",
		);
		const lock = migration.indexOf('LOCK TABLE "lookups"');
		const firstDelete = migration.indexOf('DELETE FROM "lookups"');

		expect(lock).toBeGreaterThanOrEqual(0);
		expect(lock).toBeLessThan(firstDelete);
	});
});
