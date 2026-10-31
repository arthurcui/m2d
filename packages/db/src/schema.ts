import {
  check,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    id: text('id').primaryKey(),
    instanceId: uuid('instance_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('single_worker', sql`${table.id} = 'worker'`),
    check('heartbeat_order', sql`${table.lastSeenAt} >= ${table.startedAt}`),
  ],
);

export const demoJobRuns = pgTable(
  'demo_job_runs',
  {
    jobId: uuid('job_id').primaryKey(),
    queue: text('queue').notNull(),
    version: integer('version').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('demo_version', sql`${table.version} = 1`),
    check('demo_queue', sql`${table.queue} = 'm2d.foundation-demo.v1'`),
  ],
);
