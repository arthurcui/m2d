CREATE TABLE "accounts" (
	"account_key" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"institution" text NOT NULL,
	"account_type" text NOT NULL,
	"base_currency" text NOT NULL,
	"active" boolean NOT NULL,
	"notes" text NOT NULL,
	CONSTRAINT "account_currency" CHECK ("accounts"."base_currency" in ('USD','CAD')),
	CONSTRAINT "account_type" CHECK ("accounts"."account_type" in ('CASH','MARGIN','RRSP','TFSA','OTHER'))
);
--> statement-breakpoint
CREATE TABLE "cash_projection" (
	"account_key" text NOT NULL,
	"currency" text NOT NULL,
	"balance" numeric(30, 12) NOT NULL,
	CONSTRAINT "cash_projection_account_key_currency_pk" PRIMARY KEY("account_key","currency"),
	CONSTRAINT "cash_currency" CHECK ("cash_projection"."currency" in ('USD','CAD'))
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"definition" jsonb NOT NULL,
	"asset_type" text NOT NULL,
	"symbol" text NOT NULL,
	"exchange" text NOT NULL,
	"currency" text NOT NULL,
	"multiplier" numeric(30, 12) NOT NULL,
	CONSTRAINT "instrument_currency" CHECK ("instruments"."currency" in ('USD','CAD')),
	CONSTRAINT "instrument_type" CHECK ("instruments"."asset_type" in ('STOCK','ETF','OPTION')),
	CONSTRAINT "instrument_multiplier" CHECK (("instruments"."asset_type"='OPTION' and "instruments"."multiplier"=100) or ("instruments"."asset_type"<>'OPTION' and "instruments"."multiplier"=1))
);
--> statement-breakpoint
CREATE TABLE "portfolio_baselines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"preview_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"import_id" uuid,
	"restores_baseline_id" uuid,
	CONSTRAINT "portfolio_baselines_revision_unique" UNIQUE("revision"),
	CONSTRAINT "portfolio_baselines_preview_id_unique" UNIQUE("preview_id")
);
--> statement-breakpoint
CREATE TABLE "portfolio_change_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"changes" jsonb NOT NULL,
	"note" text NOT NULL,
	CONSTRAINT "portfolio_change_log_revision_unique" UNIQUE("revision"),
	CONSTRAINT "portfolio_change_log_preview_id_unique" UNIQUE("preview_id")
);
--> statement-breakpoint
CREATE TABLE "portfolio_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"baseline_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"preview_id" uuid NOT NULL,
	"operation" jsonb NOT NULL,
	"realized" jsonb NOT NULL,
	CONSTRAINT "portfolio_events_revision_unique" UNIQUE("revision"),
	CONSTRAINT "portfolio_events_preview_id_unique" UNIQUE("preview_id")
);
--> statement-breakpoint
CREATE TABLE "portfolio_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"original_base64" text NOT NULL,
	"template_version" integer NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"errors" jsonb NOT NULL,
	"normalized" jsonb,
	CONSTRAINT "portfolio_imports_hash_unique" UNIQUE("hash"),
	CONSTRAINT "import_version" CHECK ("portfolio_imports"."template_version"=1)
);
--> statement-breakpoint
CREATE TABLE "portfolio_previews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"hash" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"import_id" uuid,
	"restores_baseline_id" uuid,
	"operation" jsonb,
	"proposed" jsonb NOT NULL,
	"changes" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"realized" jsonb NOT NULL,
	"confirmed_revision" integer,
	CONSTRAINT "portfolio_previews_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "preview_status" CHECK ("portfolio_previews"."status" in ('PENDING','CONFIRMED','EXPIRED','CONFLICT','REJECTED')),
	CONSTRAINT "preview_kind" CHECK ("portfolio_previews"."kind" in ('EVENT','BASELINE')),
	CONSTRAINT "preview_revision" CHECK ("portfolio_previews"."expected_revision">=0),
	CONSTRAINT "preview_expiry" CHECK ("portfolio_previews"."expires_at">"portfolio_previews"."created_at")
);
--> statement-breakpoint
CREATE TABLE "portfolio_revision" (
	"id" integer PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"effective_at" timestamp with time zone,
	"baseline_id" uuid,
	CONSTRAINT "portfolio_singleton" CHECK ("portfolio_revision"."id"=1),
	CONSTRAINT "revision_nonnegative" CHECK ("portfolio_revision"."revision">=0)
);
--> statement-breakpoint
CREATE TABLE "position_projection" (
	"account_key" text NOT NULL,
	"instrument_id" text NOT NULL,
	"quantity" numeric(30, 12) NOT NULL,
	"average_cost" numeric(30, 12) NOT NULL,
	"quality" text NOT NULL,
	"notes" text NOT NULL,
	CONSTRAINT "position_projection_account_key_instrument_id_pk" PRIMARY KEY("account_key","instrument_id"),
	CONSTRAINT "position_cost" CHECK ("position_projection"."average_cost">=0),
	CONSTRAINT "position_quality" CHECK ("position_projection"."quality" in ('BASELINE_ESTIMATE','COMPLETE_LEDGER','UNKNOWN'))
);
--> statement-breakpoint
ALTER TABLE "cash_projection" ADD CONSTRAINT "cash_projection_account_key_accounts_account_key_fk" FOREIGN KEY ("account_key") REFERENCES "public"."accounts"("account_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_baselines" ADD CONSTRAINT "portfolio_baselines_preview_id_portfolio_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."portfolio_previews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_baselines" ADD CONSTRAINT "portfolio_baselines_import_id_portfolio_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."portfolio_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_change_log" ADD CONSTRAINT "portfolio_change_log_preview_id_portfolio_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."portfolio_previews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_events" ADD CONSTRAINT "portfolio_events_baseline_id_portfolio_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."portfolio_baselines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_events" ADD CONSTRAINT "portfolio_events_preview_id_portfolio_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."portfolio_previews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_previews" ADD CONSTRAINT "portfolio_previews_import_id_portfolio_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."portfolio_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_projection" ADD CONSTRAINT "position_projection_account_key_accounts_account_key_fk" FOREIGN KEY ("account_key") REFERENCES "public"."accounts"("account_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_projection" ADD CONSTRAINT "position_projection_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION m2d_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Portfolio history is immutable; append a correction or baseline'; END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_baselines BEFORE UPDATE OR DELETE ON portfolio_baselines FOR EACH ROW EXECUTE FUNCTION m2d_immutable_history();
--> statement-breakpoint
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON portfolio_events FOR EACH ROW EXECUTE FUNCTION m2d_immutable_history();
--> statement-breakpoint
CREATE TRIGGER immutable_imports BEFORE UPDATE OR DELETE ON portfolio_imports FOR EACH ROW EXECUTE FUNCTION m2d_immutable_history();
--> statement-breakpoint
CREATE TRIGGER immutable_change_log BEFORE UPDATE OR DELETE ON portfolio_change_log FOR EACH ROW EXECUTE FUNCTION m2d_immutable_history();
