CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"parent_run_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"analysis_mode" text NOT NULL,
	"policy_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"adapter_version" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"effective_limits" jsonb NOT NULL,
	"portfolio_revision" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"completeness" text DEFAULT 'limited' NOT NULL,
	"limit_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"continuation" jsonb,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview_id" uuid,
	"usage" jsonb,
	"reserved_cost" numeric(30, 12) DEFAULT '0' NOT NULL,
	"estimated_cost" numeric(30, 12),
	"price_version" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_runs_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "agent_run_mode" CHECK ("agent_runs"."analysis_mode" in ('quick','standard','extensive')),
	CONSTRAINT "agent_run_status" CHECK ("agent_runs"."status" in ('running','completed','failed','cancelled','interrupted')),
	CONSTRAINT "agent_run_completeness" CHECK ("agent_runs"."completeness" in ('complete','limited')),
	CONSTRAINT "agent_run_cost_nonnegative" CHECK ("agent_runs"."reserved_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context" text NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"continuation" jsonb,
	"draft" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_context_unique" UNIQUE("context")
);
--> statement-breakpoint
CREATE TABLE "agent_tool_calls" (
	"run_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_calls_run_id_call_id_pk" PRIMARY KEY("run_id","call_id")
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"default_analysis_mode" text,
	CONSTRAINT "settings_singleton" CHECK ("app_settings"."id" = 1),
	CONSTRAINT "settings_mode" CHECK ("app_settings"."default_analysis_mode" in ('quick','standard','extensive'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_preview_id_portfolio_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."portfolio_previews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;