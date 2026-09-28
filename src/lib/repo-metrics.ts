/**
 * Pure derivations for the repository leaderboard (#212) — no I/O, so every definition the UI
 * shows is pinned by repo-metrics.test.ts.
 *
 * Definitions (surfaced verbatim on the page). The contributor *count* is not derived here — it
 * comes from REST `/contributors` (see fetchContributorCounts). These all derive from GitHub's
 * contributor statistics, which exclude merge and empty commits and usually cover only the top
 * 100 contributors, so on a truncated answer they are lower bounds:
 *   - active contributors (last year): rows with ≥1 counted commit in the trailing 52 weeks.
 *   - bus factor: the fewest contributors whose commits add up to at least half of all counted
 *     commits (barely affected by truncation — the tail beyond the top 100 is small).
 */

import type { ContributorStatsRow } from "#/lib/github-repo";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ContributorSummary {
	/** Rows GitHub returned — compare with the linked contributor count, see isStatsTruncated. */
	rows: number;
	activeContributorsLastYear: number;
	busFactor: number;
	/** Keyed by first-of-month label (YYYY-MM-01). */
	monthly: Map<string, { active: number; new: number }>;
}

/** First-of-month label for an instant, UTC. */
export function monthLabel(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 7)}-01`;
}

/**
 * Summarise `/stats/contributors`. Weekly buckets are assigned to the month their week *starts*
 * in (GitHub weeks begin Sunday 00:00 UTC), so a week straddling a month boundary counts toward
 * the earlier month — close enough for a monthly trend, and stated on the page.
 */
export function summarizeContributors(
	rows: ContributorStatsRow[],
	now: Date,
): ContributorSummary {
	const yearAgo = now.getTime() - 52 * WEEK_MS;
	const monthly = new Map<string, { active: number; new: number }>();
	const bucket = (label: string) => {
		let b = monthly.get(label);
		if (!b) {
			b = { active: 0, new: 0 };
			monthly.set(label, b);
		}
		return b;
	};

	let active = 0;
	for (const row of rows) {
		let activeThisYear = false;
		let first = true;
		const monthsActive = new Set<string>();
		for (const week of row.weeks) {
			if (week.c <= 0) continue;
			const ms = week.w * 1000;
			if (ms >= yearAgo) activeThisYear = true;
			const label = monthLabel(ms);
			if (first) {
				bucket(label).new += 1;
				first = false;
			}
			monthsActive.add(label);
		}
		for (const label of monthsActive) bucket(label).active += 1;
		if (activeThisYear) active += 1;
	}

	return {
		rows: rows.length,
		activeContributorsLastYear: active,
		busFactor: busFactor(rows.map((r) => r.total)),
		monthly,
	};
}

/**
 * Whether the statistics cover fewer people than GitHub lists as account-linked contributors. The
 * cap is not documented and not constant (100 rows for substrate, ~500 for rust-lang/rust, 495 of
 * 381 linked for polkadot-sdk), so compare against the list instead of guessing a number. Unknown
 * counts → false: nothing to claim either way.
 */
export function isStatsTruncated(
	statsRows: number | null,
	contributors: number | null,
	anonymousContributors: number | null,
): boolean {
	if (statsRows == null || contributors == null) return false;
	return statsRows < contributors - (anonymousContributors ?? 0);
}

/** Fewest contributors covering ≥50% of commits. 0 when there are no counted commits. */
export function busFactor(totals: number[]): number {
	const sorted = totals.filter((t) => t > 0).sort((a, b) => b - a);
	const all = sorted.reduce((sum, t) => sum + t, 0);
	if (all === 0) return 0;
	let covered = 0;
	for (let i = 0; i < sorted.length; i++) {
		covered += sorted[i];
		if (covered * 2 >= all) return i + 1;
	}
	return sorted.length;
}

/** Count `starredAt` timestamps per first-of-month label. */
export function starsByMonth(dates: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const d of dates) {
		const label = monthLabel(Date.parse(d));
		out.set(label, (out.get(label) ?? 0) + 1);
	}
	return out;
}

/**
 * Where a repo's monthly back-fill starts: its first counted commit week if contributor stats
 * reach further back than the repo itself (history imported or merged in — polkadot-sdk's
 * default branch predates the repository by years), otherwise the repository's creation.
 */
export function backfillStart(
	createdAt: Date,
	rows: ContributorStatsRow[] | null,
): Date {
	let earliest = createdAt.getTime();
	for (const row of rows ?? []) {
		for (const week of row.weeks) {
			if (week.c > 0 && week.w * 1000 < earliest) earliest = week.w * 1000;
		}
	}
	return new Date(earliest);
}
