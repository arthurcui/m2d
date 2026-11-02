ALTER TABLE "research_source_links" DROP CONSTRAINT "research_link_kind";--> statement-breakpoint
ALTER TABLE "source_documents" DROP CONSTRAINT "source_provider";--> statement-breakpoint
ALTER TABLE "research_source_links" ADD CONSTRAINT "research_link_kind" CHECK ("research_source_links"."kind" in ('ir','fund','occ','macro','news','analyst'));--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_provider" CHECK ("source_documents"."provider" in ('fixture','sec','upload','ir','fund','occ','macro','news','analyst'));