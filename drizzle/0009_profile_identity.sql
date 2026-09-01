-- Do not guess which history owns a duplicated immutable identity. A failed deploy leaves the
-- existing schema and data untouched, with the conflicting node ids in the exception for an
-- operator to inspect and reconcile deliberately.
DO $$
DECLARE duplicate_node_ids text;
BEGIN
	SELECT string_agg("github_node_id", ', ' ORDER BY "github_node_id")
	INTO duplicate_node_ids
	FROM (
		SELECT "github_node_id"
		FROM "entities"
		WHERE "kind" = 'user' AND "github_node_id" IS NOT NULL
		GROUP BY "github_node_id"
		HAVING count(*) > 1
	) AS duplicates;

	IF duplicate_node_ids IS NOT NULL THEN
		RAISE EXCEPTION 'Duplicate GitHub user node ids must be reconciled before migration: %', duplicate_node_ids;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "entities_user_github_node_id_idx" ON "entities" USING btree ("github_node_id") WHERE "kind" = 'user' AND "github_node_id" IS NOT NULL;
