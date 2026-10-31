CREATE TABLE "portfolio_import_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"source_import_id" uuid NOT NULL,
	"profile" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "account_currency";--> statement-breakpoint
ALTER TABLE "cash_projection" DROP CONSTRAINT "cash_currency";--> statement-breakpoint
ALTER TABLE "instruments" DROP CONSTRAINT "instrument_currency";--> statement-breakpoint
ALTER TABLE "position_projection" ALTER COLUMN "average_cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolio_import_mappings" ADD COLUMN "memory" jsonb;--> statement-breakpoint
ALTER TABLE "position_projection" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "position_projection" ADD COLUMN "option_group" text;--> statement-breakpoint
ALTER TABLE "portfolio_import_memories" ADD CONSTRAINT "portfolio_import_memories_source_import_id_portfolio_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."portfolio_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "account_currency" CHECK ("accounts"."base_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "cash_projection" ADD CONSTRAINT "cash_currency" CHECK ("cash_projection"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instrument_currency" CHECK ("instruments"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "position_projection" ADD CONSTRAINT "position_unknown_cost" CHECK ("position_projection"."average_cost" is not null or "position_projection"."quality"='UNKNOWN');
--> statement-breakpoint
CREATE TRIGGER immutable_import_memories BEFORE UPDATE OR DELETE ON portfolio_import_memories FOR EACH ROW EXECUTE FUNCTION m2d_immutable_history();
