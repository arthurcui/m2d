CREATE TABLE "portfolio_import_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"config" jsonb NOT NULL,
	"errors" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"normalized" jsonb,
	"preview_id" uuid
);
--> statement-breakpoint
ALTER TABLE "portfolio_import_mappings" ADD CONSTRAINT "portfolio_import_mappings_import_id_portfolio_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."portfolio_imports"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER immutable_import_mappings BEFORE UPDATE OR DELETE ON portfolio_import_mappings FOR EACH ROW EXECUTE FUNCTION m2d_immutable_history();
