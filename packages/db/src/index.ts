import { createResearchRepository } from './research.js';
export { type ResearchRepository, type ResearchDocument } from './research.js';
import { createChatRepository } from './chat.js';
import { createMarketRepository } from './market.js';
export { marketRequestSchema, marketSubject } from './market.js';
export type { MarketRepository, MarketRequest } from './market.js';
export type { ChatRepository } from './chat.js';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq, sql } from 'drizzle-orm';
import { DEMO_QUEUE } from '@m2d/domain';
import {
  demoJobRuns,
  workerHeartbeats,
  portfolioRevision,
  portfolioEvents,
} from './schema.js';
import { createPortfolioRepository } from './portfolio.js';
export type { PortfolioRepository } from './portfolio.js';

export interface OperationalState {
  lastHeartbeat: Date | null;
  lastDemoJob: Date | null;
}
export interface SystemRepository {
  checkReady(): Promise<void>;
  getState(): Promise<OperationalState>;
}

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  pool.on('error', () => console.error('Database connection unavailable'));
  const db = drizzle(pool);
  const repository = {
    async checkReady() {
      // Checking application tables distinguishes a reachable DB from a migrated DB.
      await pool.query('select id from agent_sessions limit 1');
      await pool.query('select id from market_observations limit 1');
      await pool.query('select provider from market_provider_limits limit 1');
      await db.select().from(workerHeartbeats).limit(1);
      await db.select().from(demoJobRuns).limit(1);
      await db.select().from(portfolioRevision).limit(1);
      await db
        .select({ id: portfolioEvents.id })
        .from(portfolioEvents)
        .limit(1);
    },
    async getState(): Promise<OperationalState> {
      const [heartbeats, jobs] = await Promise.all([
        db
          .select()
          .from(workerHeartbeats)
          .where(eq(workerHeartbeats.id, 'worker')),
        db
          .select()
          .from(demoJobRuns)
          .orderBy(desc(demoJobRuns.completedAt))
          .limit(1),
      ]);
      return {
        lastHeartbeat: heartbeats[0]?.lastSeenAt ?? null,
        lastDemoJob: jobs[0]?.completedAt ?? null,
      };
    },
    async heartbeat(instanceId: string, startedAt: Date) {
      await db
        .insert(workerHeartbeats)
        .values({ id: 'worker', instanceId, startedAt, lastSeenAt: new Date() })
        .onConflictDoUpdate({
          target: workerHeartbeats.id,
          set: { instanceId, startedAt, lastSeenAt: sql`now()` },
        });
    },
    async recordDemo(jobId: string) {
      const inserted = await db
        .insert(demoJobRuns)
        .values({ jobId, queue: DEMO_QUEUE, version: 1 })
        .onConflictDoNothing({ target: demoJobRuns.jobId })
        .returning({ jobId: demoJobRuns.jobId });
      return inserted.length === 1;
    },
  };
  return {
    pool,
    repository,
    portfolio: createPortfolioRepository(pool),
    chat: createChatRepository(pool),
    market: createMarketRepository(pool),
    research: createResearchRepository(pool),
    close: () => pool.end(),
  };
}
