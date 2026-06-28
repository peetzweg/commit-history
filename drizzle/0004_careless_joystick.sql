CREATE TABLE "ad_slots" (
	"after_rank" integer PRIMARY KEY NOT NULL,
	"tier" text NOT NULL,
	"price_weekly" integer NOT NULL,
	"checkout_url" text,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsorships" (
	"id" text PRIMARY KEY NOT NULL,
	"after_rank" integer NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"label" text NOT NULL,
	"image_url" text,
	"link_url" text NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_until" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sponsorships" ADD CONSTRAINT "sponsorships_after_rank_ad_slots_after_rank_fk" FOREIGN KEY ("after_rank") REFERENCES "public"."ad_slots"("after_rank") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Seed the five ad slots with founding weekly prices. checkout_url is filled in per slot once
-- its Stripe Payment Link exists; until then that slot shows no CTA. Edit price_weekly live to
-- run a pricing experiment — no redeploy needed.
INSERT INTO "ad_slots" ("after_rank", "tier", "price_weekly", "checkout_url", "enabled") VALUES
	(5,   'Prime',    60, NULL, true),
	(25,  'Premium',  35, NULL, true),
	(50,  'Standard', 25, NULL, true),
	(75,  'Standard', 18, NULL, true),
	(100, 'Basic',    12, NULL, true)
ON CONFLICT ("after_rank") DO NOTHING;