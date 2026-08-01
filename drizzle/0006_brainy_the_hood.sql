ALTER TABLE "entities" ADD COLUMN "unreachable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monthly_commits" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
-- Backfill provenance for rows that predate the column.
--
-- `fetched_at` exists so the monthly refresh can tell "this month is done" from "a row happens to
-- exist". Leaving every historical row NULL would be correct but would make the next pass re-fetch
-- the whole cohort, so we stamp the rows we can actually vouch for: a month whose entity was last
-- fetched at/after that month's end can only have been read as a completed month (monthlyWindows
-- has never emitted an in-progress window since a44f442, and before that the entity's last_fetched
-- was necessarily inside the month it was writing).
--
-- The stamp is `last_fetched`, which is the entity's read time, not the row's — good enough for a
-- >= month-end comparison, and deliberately conservative: anything it cannot vouch for stays NULL
-- and gets re-fetched. Verified against GitHub on a 25-row sample before shipping (24 exact, 1 off
-- by a single private contribution, which drifts on GitHub's side).
--
-- What stays NULL within that range is the residue this column was added for: 112 rows for
-- 2026-07-01 and 8 for 2026-06-01, written mid-month before a44f442 (2026-07-01 05:31 UTC) excluded
-- the in-progress month from lookups. They hold a few days of data under a full month's label
-- (jdx: 0 stored vs 837 actual) and the old existence-based gate skipped them forever.
--
-- Scoped to 2026 deliberately: 195k rows instead of the table's 4.18M / 494 MB. The gate only ever
-- asks about the month that just ended, so stamping a decade of settled history would rewrite the
-- whole table (and its WAL) on a 4 GB host to answer a question nobody asks. Pre-2026 rows keep
-- NULL = "provenance unknown", which fails safe: a pass deliberately aimed at an old month
-- re-reads rather than trusts.
UPDATE "monthly_commits" mc
SET "fetched_at" = e."last_fetched"
FROM "entities" e
WHERE e."id" = mc."entity_id"
  AND mc."month" >= DATE '2026-01-01'
  AND e."last_fetched" >= ((mc."month" + interval '1 month') AT TIME ZONE 'UTC');
