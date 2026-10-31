CREATE TABLE "market_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"content_hash" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	CONSTRAINT "market_observations_content_hash_unique" UNIQUE("content_hash"),
	CONSTRAINT "market_provider" CHECK ("market_observations"."provider" in ('fixture','twelvedata')),
	CONSTRAINT "market_kind" CHECK ("market_observations"."kind" in ('quote','bars','fx','options')),
	CONSTRAINT "market_observation_time" CHECK ("market_observations"."as_of" <= "market_observations"."received_at" and "market_observations"."received_at" <= "market_observations"."available_at")
);
--> statement-breakpoint
CREATE TABLE "market_refreshes" (
	"request_key" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"observation_id" uuid,
	CONSTRAINT "market_refresh_status" CHECK ("market_refreshes"."status" in ('PENDING','SUCCEEDED','FAILED'))
);
--> statement-breakpoint
CREATE TABLE "valuation_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_key" text NOT NULL,
	"portfolio_revision" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"base_currency" text NOT NULL,
	"valuation" jsonb NOT NULL,
	"observation_ids" jsonb NOT NULL,
	CONSTRAINT "valuation_snapshots_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "valuation_revision" CHECK ("valuation_snapshots"."portfolio_revision">=0),
	CONSTRAINT "valuation_currency" CHECK ("valuation_snapshots"."base_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "market_refreshes" ADD CONSTRAINT "market_refreshes_observation_id_market_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."market_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_lookup" ON "market_observations" USING btree ("provider","kind","subject","as_of");