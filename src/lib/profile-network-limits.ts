/** Bound automatic first-degree expansion to a useful, affordable cohort. */
export const MAX_FOLLOWED_PROFILES = 250;
export const MAX_PENDING_PROFILE_JOBS = 1_000;

export const TOO_LARGE_MESSAGE = `GitHub following lookup exceeded ${MAX_FOLLOWED_PROFILES} profiles.`;

/** Recognize both today's limit and failures persisted by older preview revisions. */
export function isNetworkTooLargeFailure(error: unknown): boolean {
	return /GitHub following lookup exceeded \d+ profiles\./.test(String(error));
}

export function networkAdmission(
	followingCount: number | null,
	pendingJobs: number,
): "allowed" | "too_large" | "busy" {
	if (followingCount != null && followingCount > MAX_FOLLOWED_PROFILES) {
		return "too_large";
	}
	const worstCaseJobs = followingCount ?? MAX_FOLLOWED_PROFILES;
	return pendingJobs + worstCaseJobs > MAX_PENDING_PROFILE_JOBS
		? "busy"
		: "allowed";
}
