import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Drizzle client over Neon's HTTP driver (no TCP pool — works in serverless/edge).
 *
 * `db` is null when DATABASE_URL is unset, so the cache layer transparently falls back to its
 * in-memory store. That keeps local dev (and the app) working with no database configured.
 */
const url = process.env.DATABASE_URL;

export const db = url ? drizzle(neon(url), { schema }) : null;

export type DB = NonNullable<typeof db>;
