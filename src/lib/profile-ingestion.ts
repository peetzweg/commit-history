import { db } from "#/lib/db";
import {
	fetchMonthlyCommits,
	fetchProfile,
	fetchProfileByNodeId,
	fetchRateLimitBudget,
} from "#/lib/github";
import {
	createProfileIngestion,
	type ProfileIngestionResult,
	type ProfileIngestionTarget,
	type RunProfileIngestionOptions,
} from "#/lib/profile-ingestion-engine";
import { createProfileIngestionStore } from "#/lib/profile-ingestion-store";

export type {
	ProfileIngestionResult,
	ProfileIngestionTarget,
	RunProfileIngestionOptions,
};

/**
 * Turn one GitHub identity into a complete, resumable commit history.
 *
 * This is the whole caller interface. HTTP requests bound it with `maxRuntimeMs`; a later worker
 * can call the same operation with an immutable node id and a rate-limit floor. Persistence,
 * identity reconciliation, chunking, completion, and GitHub request details remain behind it.
 */
export async function runProfileIngestion(
	target: ProfileIngestionTarget,
	opts: RunProfileIngestionOptions,
): Promise<ProfileIngestionResult> {
	if (!db) {
		throw new Error("Profile ingestion requires DATABASE_URL.");
	}
	const run = createProfileIngestion({
		store: createProfileIngestionStore(db),
		github: {
			fetchProfileByLogin: fetchProfile,
			fetchProfileByNodeId,
			fetchMonthlyCommits,
			fetchRateLimitBudget,
		},
	});
	return run(target, opts);
}
