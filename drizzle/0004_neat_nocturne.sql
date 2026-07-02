ALTER TABLE "entities" ADD COLUMN "total_issues" integer;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "total_pull_requests" integer;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "total_reviews" integer;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "total_repos" integer;--> statement-breakpoint
ALTER TABLE "monthly_commits" ADD COLUMN "issues" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monthly_commits" ADD COLUMN "pull_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monthly_commits" ADD COLUMN "reviews" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monthly_commits" ADD COLUMN "repos" integer DEFAULT 0 NOT NULL;