CREATE TABLE "month_to_date_snapshots" (
	"entity_id" text NOT NULL,
	"day" date NOT NULL,
	"month" date NOT NULL,
	"commits" integer NOT NULL,
	"restricted" integer NOT NULL,
	"issues" integer NOT NULL,
	"pull_requests" integer NOT NULL,
	"reviews" integer NOT NULL,
	"repos" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "month_to_date_snapshots_entity_id_day_pk" PRIMARY KEY("entity_id","day")
);
--> statement-breakpoint
ALTER TABLE "month_to_date_snapshots" ADD CONSTRAINT "month_to_date_snapshots_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "month_to_date_snapshots_entity_fetched_idx" ON "month_to_date_snapshots" USING btree ("entity_id","fetched_at");