CREATE TABLE "org_member_monthly" (
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"month" date NOT NULL,
	"commits" integer DEFAULT 0 NOT NULL,
	"pull_requests" integer DEFAULT 0 NOT NULL,
	"reviews" integer DEFAULT 0 NOT NULL,
	"issues" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "org_member_monthly_org_id_member_id_month_pk" PRIMARY KEY("org_id","member_id","month")
);
--> statement-breakpoint
ALTER TABLE "org_member_monthly" ADD CONSTRAINT "org_member_monthly_org_id_entities_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_monthly" ADD CONSTRAINT "org_member_monthly_member_id_entities_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;