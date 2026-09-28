CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"github_node_id" text,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_avatar_url" text,
	"primary_language" text,
	"license" text,
	"created_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"is_archived" boolean,
	"is_fork" boolean,
	"default_branch" text,
	"default_branch_tip_sha" text,
	"stars" integer,
	"forks" integer,
	"watchers" integer,
	"commits" integer,
	"commits_last_year" integer,
	"open_issues" integer,
	"closed_issues" integer,
	"open_pull_requests" integer,
	"merged_pull_requests" integer,
	"closed_pull_requests" integer,
	"releases" integer,
	"contributors" integer,
	"anonymous_contributors" integer,
	"active_contributors_last_year" integer,
	"bus_factor" integer,
	"metrics_fetched_at" timestamp with time zone,
	"stats_fetched_at" timestamp with time zone,
	"stats_tip_sha" text,
	"stars_backfilled_at" timestamp with time zone,
	"unreachable_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repository_monthly" (
	"repo_id" text NOT NULL,
	"month" date NOT NULL,
	"commits" integer NOT NULL,
	"issues_opened" integer NOT NULL,
	"issues_closed" integer NOT NULL,
	"pull_requests_opened" integer NOT NULL,
	"pull_requests_merged" integer NOT NULL,
	"active_contributors" integer,
	"new_contributors" integer,
	"stars_gained" integer,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "repository_monthly_repo_id_month_pk" PRIMARY KEY("repo_id","month")
);
--> statement-breakpoint
CREATE TABLE "repository_snapshots" (
	"repo_id" text NOT NULL,
	"day" date NOT NULL,
	"stars" integer NOT NULL,
	"forks" integer NOT NULL,
	"watchers" integer NOT NULL,
	"commits" integer NOT NULL,
	"open_issues" integer NOT NULL,
	"open_pull_requests" integer NOT NULL,
	"merged_pull_requests" integer NOT NULL,
	"releases" integer NOT NULL,
	"contributors" integer,
	"measured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "repository_snapshots_repo_id_day_pk" PRIMARY KEY("repo_id","day")
);
--> statement-breakpoint
ALTER TABLE "repository_monthly" ADD CONSTRAINT "repository_monthly_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_snapshots" ADD CONSTRAINT "repository_snapshots_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;