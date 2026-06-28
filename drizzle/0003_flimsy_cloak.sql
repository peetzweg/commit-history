ALTER TABLE "entities" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "suspended_reason" text;