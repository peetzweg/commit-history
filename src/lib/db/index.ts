import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Drizzle client over postgres.js — plain TCP, so it works against any Postgres: Neon today
 * (the `?sslmode=require` in its URL switches TLS on), the self-hosted Coolify instance after
 * the devops#4 cutover. `prepare: false` because Neon's pooled endpoint is PgBouncer in
 * transaction mode, where named prepared statements can't be relied on; harmless elsewhere.
 *
 * `db` is null when DATABASE_URL is unset, so the cache layer transparently falls back to its
 * in-memory store. That keeps local dev (and the app) working with no database configured.
 */
const url = process.env.DATABASE_URL;

export const db = url
	? drizzle(postgres(url, { prepare: false }), { schema })
	: null;

export type DB = NonNullable<typeof db>;
