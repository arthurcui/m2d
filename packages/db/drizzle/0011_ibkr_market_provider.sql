ALTER TABLE "market_observations" DROP CONSTRAINT "market_provider";--> statement-breakpoint
ALTER TABLE "market_provider_limits" DROP CONSTRAINT "market_limit_provider";--> statement-breakpoint
ALTER TABLE "market_observations" ADD CONSTRAINT "market_provider" CHECK ("market_observations"."provider" in ('fixture','twelvedata','massive','ibkr'));--> statement-breakpoint
ALTER TABLE "market_provider_limits" ADD CONSTRAINT "market_limit_provider" CHECK ("market_provider_limits"."provider" in ('massive','ibkr'));