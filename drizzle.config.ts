import { defineConfig } from "drizzle-kit";

// Load .env so `drizzle-kit migrate/studio` see DATABASE_URL (Node 20.6+ / 24).
try {
	process.loadEnvFile?.(".env");
} catch {
	/* no .env yet — fine for `generate`, which doesn't need a connection */
}

export default defineConfig({
	schema: "./src/lib/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
