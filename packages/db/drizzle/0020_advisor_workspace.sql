CREATE TABLE "research_company_choices" (
	"symbol" text PRIMARY KEY NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_choice_symbol" CHECK ("research_company_choices"."symbol" ~ '^[A-Z0-9.-]{1,24}$')
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "output_language" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "output_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_run_language" CHECK ("agent_runs"."output_language" in ('en','zh-CN'));--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "settings_language" CHECK ("app_settings"."output_language" in ('en','zh-CN'));