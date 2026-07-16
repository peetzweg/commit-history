/**
 * Moderation CLI: hide a gamed/suspicious account from the leaderboard until it's investigated.
 *
 * Run with bun, which auto-loads the local (un-committed) `.env`, so no `--env-file` flag:
 *
 *   bun run suspend <login> ["reason"]   # suspend (asks to confirm)
 *   bun run suspend --remove <login>     # reactivate
 *   bun run suspend --list               # list suspended accounts
 *
 * Suspension is a soft, reversible flag (entities.suspended_at) — no data is deleted. A suspended
 * account drops off the leaderboard and "recently looked up" but is still directly viewable, with
 * an under-review notice. Mirrors scripts/refresh.ts: plain tagged-template SQL, no build step.
 */
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required (add it to .env)");

// prepare: false — Neon's pooled endpoint is PgBouncer transaction mode (see src/lib/db).
const sql = postgres(DATABASE_URL, { prepare: false });

const entityId = (login: string) => `user:${login.trim().toLowerCase()}`;
const profileUrl = (login: string) => `https://commit-history.com/${login}`;

/** Ask for an explicit yes; anything else aborts. */
function confirm(question: string): boolean {
	const answer = (prompt(`${question} [y/N]`) ?? "").trim().toLowerCase();
	return answer === "y" || answer === "yes";
}

async function list() {
	const rows = await sql`
		select login, suspended_at, suspended_reason from entities
		where suspended_at is not null order by suspended_at desc`;
	if (rows.length === 0) {
		console.log("No suspended accounts.");
		return;
	}
	console.log(`${rows.length} suspended:\n`);
	for (const r of rows) {
		const when = new Date(r.suspended_at).toISOString().slice(0, 10);
		console.log(
			`  ${r.login.padEnd(24)} ${when}  ${r.suspended_reason ?? ""}`.trimEnd(),
		);
	}
}

async function remove(login: string) {
	const id = entityId(login);
	const [row] = await sql`select login from entities where id = ${id}`;
	if (!row) {
		console.error(`✗ "${login}" is not in the database — check the spelling.`);
		process.exit(1);
	}
	if (!confirm(`Reactivate ${row.login}?`)) {
		console.log("Aborted.");
		return;
	}
	await sql`update entities set suspended_at = null, suspended_reason = null where id = ${id}`;
	console.log(`✓ Reactivated. ${profileUrl(row.login)}`);
}

async function suspend(login: string, reason: string | null) {
	const id = entityId(login);
	const [row] = await sql`select login, suspended_at from entities where id = ${id}`;
	if (!row) {
		console.error(
			`✗ "${login}" is not in the database yet — nobody has looked them up. Check the spelling.`,
		);
		process.exit(1);
	}
	if (row.suspended_at) {
		console.log(`${row.login} is already suspended. ${profileUrl(row.login)}`);
		return;
	}
	if (!confirm(`Suspend ${row.login} from the leaderboard?`)) {
		console.log("Aborted.");
		return;
	}
	await sql`update entities set suspended_at = now(), suspended_reason = ${reason} where id = ${id}`;
	console.log(`✓ Suspended. ${profileUrl(row.login)}`);
}

const [arg1, arg2, ...rest] = process.argv.slice(2);

if (arg1 === "--list") {
	await list();
} else if (arg1 === "--remove") {
	if (!arg2) throw new Error("usage: bun run suspend --remove <login>");
	await remove(arg2);
} else if (arg1 && !arg1.startsWith("--")) {
	const reason = [arg2, ...rest].filter(Boolean).join(" ") || null;
	await suspend(arg1, reason);
} else {
	console.log(
		[
			"Usage:",
			'  bun run suspend <login> ["reason"]   suspend an account',
			"  bun run suspend --remove <login>     reactivate an account",
			"  bun run suspend --list               list suspended accounts",
		].join("\n"),
	);
	process.exit(arg1 ? 1 : 0);
}

// postgres.js keeps its pool open — close it or the script never exits.
await sql.end();
