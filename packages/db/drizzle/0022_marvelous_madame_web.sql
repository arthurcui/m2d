CREATE TABLE "trade_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"portfolio_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"input" jsonb NOT NULL,
	"assessment" jsonb NOT NULL,
	CONSTRAINT "trade_plans_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "plan_revision" CHECK ("trade_plans"."portfolio_revision">=0),
	CONSTRAINT "plan_watch_only" CHECK ("trade_plans"."status"='WATCH_ONLY')
);
