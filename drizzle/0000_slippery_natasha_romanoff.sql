CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"html_url" text,
	"created_at" timestamp with time zone,
	"total_commits" integer DEFAULT 0 NOT NULL,
	"last_fetched" timestamp with time zone,
	"built_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lookups" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"searched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monthly_commits" (
	"entity_id" text NOT NULL,
	"month" date NOT NULL,
	"commits" integer NOT NULL,
	CONSTRAINT "monthly_commits_entity_id_month_pk" PRIMARY KEY("entity_id","month")
);
--> statement-breakpoint
ALTER TABLE "lookups" ADD CONSTRAINT "lookups_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_commits" ADD CONSTRAINT "monthly_commits_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;