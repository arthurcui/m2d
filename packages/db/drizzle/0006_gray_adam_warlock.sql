CREATE TABLE "portfolio_account_aliases" (
	"sheet_name" text PRIMARY KEY NOT NULL,
	"account_key" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"source_import_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "position_projection" ADD COLUMN "transaction_date" date;--> statement-breakpoint
ALTER TABLE "portfolio_account_aliases" ADD CONSTRAINT "portfolio_account_aliases_account_key_accounts_account_key_fk" FOREIGN KEY ("account_key") REFERENCES "public"."accounts"("account_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_account_aliases" ADD CONSTRAINT "portfolio_account_aliases_source_import_id_portfolio_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."portfolio_imports"("id") ON DELETE no action ON UPDATE no action;