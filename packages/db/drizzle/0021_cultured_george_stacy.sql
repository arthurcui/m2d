DROP INDEX "source_document_content";--> statement-breakpoint
CREATE INDEX "source_document_content" ON "source_documents" USING btree ("company_id","provider","upstream_key","hash");