-- Lookups are UI recency state, not an event log. Retain one newest row per entity and then
-- trim the list before making that invariant enforceable with a unique index.
DELETE FROM "lookups"
WHERE "id" IN (
	SELECT "id"
	FROM (
		SELECT
			"id",
			row_number() OVER (
				PARTITION BY "entity_id"
				ORDER BY "searched_at" DESC, "id" DESC
			) AS "position"
		FROM "lookups"
	) AS "ranked"
	WHERE "position" > 1
);--> statement-breakpoint
DELETE FROM "lookups"
WHERE "id" IN (
	SELECT "id"
	FROM "lookups"
	ORDER BY "searched_at" DESC, "id" DESC
	OFFSET 64
);--> statement-breakpoint
CREATE UNIQUE INDEX "lookups_entity_id_idx" ON "lookups" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "lookups_searched_at_idx" ON "lookups" USING btree ("searched_at");
