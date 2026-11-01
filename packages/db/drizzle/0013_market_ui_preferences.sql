ALTER TABLE "app_settings" ADD COLUMN "market_provider" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "listing_provider" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "price_refresh_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "settings_market_provider" CHECK ("app_settings"."market_provider" in ('fixture','massive','ibkr','twelvedata'));--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "settings_listing_provider" CHECK ("app_settings"."listing_provider" in ('none','fixture','massive','ibkr'));--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "settings_price_refresh" CHECK ("app_settings"."price_refresh_seconds" = 0 or "app_settings"."price_refresh_seconds" between 15 and 3600);