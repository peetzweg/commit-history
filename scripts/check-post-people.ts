/**
 * Guard for the ranking posts (src/content/posts/*.mdx): make sure nobody listed in a
 * "top 10" article has since been suspended (gamed/under-investigation). Those posts are static
 * snapshots — a person suspended after publication stays frozen in the article and its ItemList
 * structured data unless we catch it — so run this before refreshing or on a schedule.
 *
 * Run with bun, which auto-loads the local `.env` (point DATABASE_URL at the DB you want to check;
 * see CLAUDE.md — normally the dev copy):
 *
 *   bun run check:posts
 *
 * Exits non-zero if any featured login is suspended or missing, listing which post to fix.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parse } from "yaml";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required (add it to .env)");

const postsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../src/content/posts",
);

interface PostPerson {
	login: string;
	name: string;
}

// Collect (post slug, login) pairs from every post's `people` frontmatter.
const entries: { slug: string; login: string }[] = [];
for (const file of readdirSync(postsDir)) {
	if (!file.endsWith(".mdx")) continue;
	const source = readFileSync(join(postsDir, file), "utf8");
	const match = source.match(/^---\n([\s\S]*?)\n---/);
	if (!match) continue;
	const fm = parse(match[1]) as { people?: PostPerson[] };
	for (const p of fm.people ?? []) {
		entries.push({ slug: file.replace(/\.mdx$/, ""), login: p.login });
	}
}

if (entries.length === 0) {
	console.log("No people found in any post — nothing to check.");
	process.exit(0);
}

const sql = postgres(DATABASE_URL, { prepare: false });
const ids = [...new Set(entries.map((e) => `user:${e.login.toLowerCase()}`))];
const rows = await sql`
	select id, login, suspended_at from entities where id = any(${ids})`;
await sql.end();

const byId = new Map(rows.map((r) => [r.id as string, r]));

const problems: string[] = [];
for (const { slug, login } of entries) {
	const row = byId.get(`user:${login.toLowerCase()}`);
	if (!row) {
		problems.push(`${slug}: @${login} — NOT in the database`);
	} else if (row.suspended_at) {
		problems.push(`${slug}: @${login} — SUSPENDED (remove from the post)`);
	}
}

if (problems.length > 0) {
	console.error(`❌ ${problems.length} issue(s) in ranking posts:\n`);
	for (const p of problems) console.error(`  ${p}`);
	process.exit(1);
}

console.log(
	`✅ All ${entries.length} featured accounts across the ranking posts are active.`,
);
