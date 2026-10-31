CREATE TABLE "portfolio_import_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "portfolio_import_runs_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "import_run_status" CHECK ("portfolio_import_runs"."status" IN ('RUNNING','COMPLETED','FAILED'))
);
--> statement-breakpoint
ALTER TABLE "portfolio_import_runs" ADD CONSTRAINT "portfolio_import_runs_import_id_portfolio_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."portfolio_imports"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION m2d_import_run_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR OLD.status <> 'RUNNING' THEN RAISE EXCEPTION 'AI import audit is immutable'; END IF; IF NEW.id <> OLD.id OR NEW.request_key <> OLD.request_key OR NEW.fingerprint <> OLD.fingerprint OR NEW.request IS DISTINCT FROM OLD.request OR NEW.import_id <> OLD.import_id OR NEW.provider <> OLD.provider OR NEW.model <> OLD.model OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'AI import request is immutable'; END IF; RETURN NEW; END; $$;
--> statement-breakpoint
CREATE TRIGGER immutable_import_run BEFORE UPDATE OR DELETE ON portfolio_import_runs FOR EACH ROW EXECUTE FUNCTION m2d_import_run_audit();
