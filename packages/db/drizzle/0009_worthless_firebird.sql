CREATE TABLE "market_provider_limits" (
	"provider" text PRIMARY KEY NOT NULL,
	"next_allowed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_limit_provider" CHECK ("market_provider_limits"."provider" = 'massive')
);
