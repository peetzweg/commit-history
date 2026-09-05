ALTER TABLE "profile_network_members" ADD COLUMN "kind" text DEFAULT 'org' NOT NULL;
--> statement-breakpoint
UPDATE "profile_network_members" AS "member"
SET "kind" = "entity"."kind"
FROM "entities" AS "entity"
WHERE "entity"."github_node_id" = "member"."member_github_node_id"
	AND "entity"."kind" IN ('user', 'org');
--> statement-breakpoint
-- Existing snapshots predate persisted account kinds. Make them stale so the next profile visit
-- replaces them with an authoritative GitHub-classified snapshot. Unknown legacy rows default to
-- `org`, which is the safe failure mode: they cannot appear or enter profile ingestion meanwhile.
UPDATE "profile_networks"
SET "enumerated_at" = NULL,
	"refresh_requested_at" = NULL,
	"last_error" = NULL;
