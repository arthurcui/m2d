CREATE TABLE "demo_job_runs" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"version" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_version" CHECK ("demo_job_runs"."version" = 1),
	CONSTRAINT "demo_queue" CHECK ("demo_job_runs"."queue" = 'm2d.foundation-demo.v1')
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "single_worker" CHECK ("worker_heartbeats"."id" = 'worker'),
	CONSTRAINT "heartbeat_order" CHECK ("worker_heartbeats"."last_seen_at" >= "worker_heartbeats"."started_at")
);
