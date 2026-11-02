CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "research_chunk_embeddings" (
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"profile" text NOT NULL,
	"embedding_id" text NOT NULL,
	CONSTRAINT "research_chunk_embeddings_document_id_chunk_index_profile_pk" PRIMARY KEY("document_id","chunk_index","profile")
);
--> statement-breakpoint
CREATE TABLE "research_embedding_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile" text NOT NULL,
	"purpose" text NOT NULL,
	"agent_run_id" uuid,
	"input_bytes" integer NOT NULL,
	"input_tokens" integer,
	"cost" numeric NOT NULL,
	"price_version" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_usage_positive" CHECK ("research_embedding_usage"."input_bytes">0 and ("research_embedding_usage"."input_tokens" is null or "research_embedding_usage"."input_tokens">=0) and "research_embedding_usage"."cost">=0),
	CONSTRAINT "embedding_usage_status" CHECK ("research_embedding_usage"."status" in ('reserved','completed','uncertain')),
	CONSTRAINT "embedding_usage_purpose" CHECK ("research_embedding_usage"."purpose" in ('query','passage'))
);
--> statement-breakpoint
CREATE TABLE "research_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"profile" text NOT NULL,
	"purpose" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_id_sha256" CHECK ("research_embeddings"."id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "embedding_purpose" CHECK ("research_embeddings"."purpose" in ('query','passage'))
);
--> statement-breakpoint
CREATE TABLE "research_search_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"profile" text NOT NULL,
	"status" text NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "search_job_status" CHECK ("research_search_jobs"."status" in ('running','completed','failed','interrupted')),
	CONSTRAINT "search_job_progress" CHECK ("research_search_jobs"."processed">=0)
);
--> statement-breakpoint
ALTER TABLE "research_chunk_embeddings" ADD CONSTRAINT "research_chunk_embeddings_embedding_id_research_embeddings_id_fk" FOREIGN KEY ("embedding_id") REFERENCES "public"."research_embeddings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_chunk_embeddings" ADD CONSTRAINT "research_chunk_embeddings_document_id_chunk_index_document_chunks_document_id_chunk_index_fk" FOREIGN KEY ("document_id","chunk_index") REFERENCES "public"."document_chunks"("document_id","chunk_index") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_embedding_usage" ADD CONSTRAINT "research_embedding_usage_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embedding_usage_date" ON "research_embedding_usage" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_search_index_job" ON "research_search_jobs" USING btree ("status") WHERE "research_search_jobs"."status"='running';