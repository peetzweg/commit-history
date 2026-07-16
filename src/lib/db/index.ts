import * as schema from "./schema";

/**
 * Drizzle client over postgres.js — plain TCP, so it works against any Postgres: Neon today
 * (the `?sslmode=require` in its URL switches TLS on), the self-hosted Coolify instance after
 * the devops#4 cutover.
 *
 * The driver is loaded via dynamic import behind a server check: postgres.js is Node-only
 * (top-level Buffer usage), and this module sits in the import graph of client-shared files —
 * commit-history.ts / org.ts export RPC stubs and shared helpers alongside their handlers.
 * A static import would drag the driver into the browser bundle and crash it at module eval
 * ("Buffer is not defined"). The old Neon HTTP driver was fetch-based and browser-safe, which
 * is what kept this leak invisible until the swap.
 *
 * `db` is null when DATABASE_URL is unset (and always in the browser), so the cache layer
 * transparently falls back to its in-memory store. That keeps local dev (and the app) working
 * with no database configured.
 */
async function createDb(url: string) {
	const [{ drizzle }, { default: postgres }] = await Promise.all([
		import("drizzle-orm/postgres-js"),
		import("postgres"),
	]);
	// prepare: false — Neon's pooled endpoint is PgBouncer in transaction mode, where named
	// prepared statements can't be relied on; harmless against a direct Postgres.
	return drizzle(postgres(url, { prepare: false }), { schema });
}

const url =
	typeof window === "undefined" ? process.env.DATABASE_URL : undefined;

export const db = url ? await createDb(url) : null;

export type DB = NonNullable<typeof db>;
