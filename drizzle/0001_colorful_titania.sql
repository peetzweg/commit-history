ALTER TABLE "entities" ADD COLUMN "total_restricted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monthly_commits" ADD COLUMN "restricted" integer DEFAULT 0 NOT NULL;