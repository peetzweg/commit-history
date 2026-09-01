import { fetchProfile, isValidLogin } from "#/lib/github";
import {
	createProfileIngestionBoss,
	createProfileIngestionQueue,
} from "#/lib/profile-ingestion-queue";

const connectionString = process.env.DATABASE_URL?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const [loginArgument, ...extraArguments] = process.argv.slice(2);
const login = loginArgument?.trim();

if (!connectionString) throw new Error("DATABASE_URL is required.");
if (!token) throw new Error("GITHUB_TOKEN is required.");
if (!login || extraArguments.length > 0 || !isValidLogin(login)) {
	throw new Error("Usage: pnpm profile:enqueue <github-login>");
}

const profile = await fetchProfile(login, token);
const boss = createProfileIngestionBoss(connectionString);
const queue = createProfileIngestionQueue(boss);

try {
	await queue.start();
	const result = await queue.request({
		version: 1,
		githubNodeId: profile.nodeId,
		login: profile.login,
	});
	console.log(
		`profile-ingestion-enqueue status=${result.disposition} login=${JSON.stringify(profile.login)} node_id=${JSON.stringify(profile.nodeId)} job_id=${result.jobId}`,
	);
} finally {
	await queue.stop().catch(() => {});
}
