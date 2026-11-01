CREATE TABLE "research_source_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_link_kind" CHECK ("research_source_links"."kind" in ('ir','fund','occ','macro','news')),
	CONSTRAINT "research_link_symbol" CHECK ("research_source_links"."symbol" ~ '^[A-Z0-9.-]{1,24}$'),
	CONSTRAINT "research_link_name" CHECK (length("research_source_links"."name") between 1 and 150),
	CONSTRAINT "research_link_url" CHECK ("research_source_links"."url" like 'https://%' and length("research_source_links"."url")<=2000)
);
--> statement-breakpoint
ALTER TABLE "source_documents" DROP CONSTRAINT "source_provider";--> statement-breakpoint
CREATE UNIQUE INDEX "research_source_link_unique" ON "research_source_links" USING btree ("symbol","kind","url");--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_provider" CHECK ("source_documents"."provider" in ('fixture','sec','upload','ir','fund','occ','macro','news'));