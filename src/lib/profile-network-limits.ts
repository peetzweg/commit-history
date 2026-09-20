/** Limit queue growth per network pass, without limiting the network's total size. */
export const NETWORK_BACKFILL_BATCH = 50;
export const MAX_PENDING_PROFILE_JOBS = 1_000;

export function networkAdmission(pendingJobs: number): "allowed" | "busy" {
	return pendingJobs + NETWORK_BACKFILL_BATCH > MAX_PENDING_PROFILE_JOBS
		? "busy"
		: "allowed";
}
