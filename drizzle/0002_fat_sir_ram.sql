ALTER TABLE "entities" ADD COLUMN "followers" integer;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "following" integer;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "public_repos" integer;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "twitter_username" text;