CREATE TABLE "profile_network_members" (
	"owner_id" text NOT NULL,
	"member_github_node_id" text NOT NULL,
	"login" text NOT NULL,
	"avatar_url" text,
	"html_url" text,
	"unavailable_at" timestamp with time zone,
	CONSTRAINT "profile_network_members_owner_id_member_github_node_id_pk" PRIMARY KEY("owner_id","member_github_node_id")
);
--> statement-breakpoint
CREATE TABLE "profile_networks" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"enumerated_at" timestamp with time zone,
	"refresh_requested_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "profile_network_members" ADD CONSTRAINT "profile_network_members_owner_id_entities_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_networks" ADD CONSTRAINT "profile_networks_owner_id_entities_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_network_members_node_idx" ON "profile_network_members" USING btree ("member_github_node_id");