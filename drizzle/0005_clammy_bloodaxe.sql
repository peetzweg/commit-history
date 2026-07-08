CREATE TABLE "org_members" (
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"role" text,
	"source" text DEFAULT 'public_member' NOT NULL,
	"commits" integer DEFAULT 0 NOT NULL,
	"pull_requests" integer DEFAULT 0 NOT NULL,
	"reviews" integer DEFAULT 0 NOT NULL,
	"issues" integer DEFAULT 0 NOT NULL,
	"last_fetched" timestamp with time zone,
	CONSTRAINT "org_members_org_id_member_id_pk" PRIMARY KEY("org_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "is_verified" boolean;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "github_node_id" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "member_count" integer;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_entities_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_member_id_entities_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_members_member_idx" ON "org_members" USING btree ("member_id");