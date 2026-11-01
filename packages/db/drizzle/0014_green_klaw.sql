CREATE TABLE "company_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"unit" text NOT NULL,
	"period_start" date,
	"period_end" date NOT NULL,
	"value" numeric NOT NULL,
	"accession" text NOT NULL,
	"filed" date NOT NULL,
	CONSTRAINT "fact_period" CHECK ("company_facts"."period_start" is null or "company_facts"."period_start"<="company_facts"."period_end")
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"page" integer,
	"text" text NOT NULL,
	CONSTRAINT "document_chunks_document_id_chunk_index_pk" PRIMARY KEY("document_id","chunk_index"),
	CONSTRAINT "chunk_index_nonnegative" CHECK ("document_chunks"."chunk_index">=0),
	CONSTRAINT "chunk_page_positive" CHECK ("document_chunks"."page" is null or "document_chunks"."page">0)
);
--> statement-breakpoint
CREATE TABLE "research_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"cik" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_companies_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "research_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"claim" text NOT NULL,
	"category" text NOT NULL,
	"extractor_version" text NOT NULL,
	CONSTRAINT "finding_category" CHECK ("research_findings"."category" in ('guidance','risk','business','financial'))
);
--> statement-breakpoint
CREATE TABLE "research_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"provider" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "research_import_status" CHECK ("research_imports"."status" in ('running','completed','failed','interrupted'))
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"upstream_key" text NOT NULL,
	"title" text NOT NULL,
	"form" text NOT NULL,
	"url" text,
	"published_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"hash" text NOT NULL,
	"revision" integer NOT NULL,
	"mime" text NOT NULL,
	"raw_base64" text NOT NULL,
	CONSTRAINT "source_provider" CHECK ("source_documents"."provider" in ('fixture','sec','upload')),
	CONSTRAINT "source_revision" CHECK ("source_documents"."revision">0),
	CONSTRAINT "source_available" CHECK ("source_documents"."available_at">="source_documents"."observed_at" and ("source_documents"."published_at" is null or "source_documents"."available_at">="source_documents"."published_at"))
);
--> statement-breakpoint
ALTER TABLE "company_facts" ADD CONSTRAINT "company_facts_document_id_source_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_source_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_document_id_source_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_company_id_research_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."research_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fact_document_metric" ON "company_facts" USING btree ("document_id","metric");--> statement-breakpoint
CREATE INDEX "document_search" ON "document_chunks" USING gin (to_tsvector('english',"text"));--> statement-breakpoint
CREATE INDEX "research_import_symbol" ON "research_imports" USING btree ("symbol","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_document_content" ON "source_documents" USING btree ("company_id","provider","upstream_key","hash");--> statement-breakpoint
CREATE UNIQUE INDEX "source_document_revision" ON "source_documents" USING btree ("company_id","provider","upstream_key","revision");--> statement-breakpoint
CREATE INDEX "source_company_available" ON "source_documents" USING btree ("company_id","available_at");