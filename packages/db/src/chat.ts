import { randomUUID, createHash } from 'node:crypto';
import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, desc, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { PortfolioError } from '@m2d/portfolio';
import type { CanonicalItem, Continuation } from '@m2d/llm';
import * as t from './schema.js';
const fingerprint = (v: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(v, (_k, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      ),
    )
    .digest('hex');
export function createChatRepository(pool: pg.Pool) {
  const db = drizzle(pool);
  const publicRun = (r: typeof t.agentRuns.$inferSelect) => {
    const { history: _h, continuation: _c, fingerprint: _f, ...rest } = r;
    void _h;
    void _c;
    void _f;
    return rest;
  };
  const getRun = async (id: string) => {
    const [r] = await db
      .select()
      .from(t.agentRuns)
      .where(eq(t.agentRuns.id, id));
    if (!r) throw new PortfolioError('RUN_NOT_FOUND', 'Run not found.', 404);
    return r;
  };
  const settings = async () => {
    await db.insert(t.appSettings).values({ id: 1 }).onConflictDoNothing();
    return (await db.select().from(t.appSettings))[0]!;
  };
  const session = async (context: string) => {
    await db.insert(t.agentSessions).values({ context }).onConflictDoNothing();
    return (
      await db
        .select()
        .from(t.agentSessions)
        .where(eq(t.agentSessions.context, context))
    )[0]!;
  };
  // Only call while holding the inference advisory lock. No live run can be
  // mistaken for a crashed process, including when another API process exists.
  const recoverHeld = async () => {
    const stale = await db
      .select()
      .from(t.agentRuns)
      .where(eq(t.agentRuns.status, 'running'));
    for (const run of stale) {
      const history = [...(run.history as CanonicalItem[])];
      const answered = new Set(
        history.filter((i) => i.kind === 'tool_result').map((i) => i.callId),
      );
      for (const item of history.filter((i) => i.kind === 'tool_call'))
        if (!answered.has(item.callId))
          history.push({
            id: randomUUID(),
            kind: 'tool_result',
            callId: item.callId,
            output: { error: { code: 'PROCESS_INTERRUPTED' } },
          });
      history.push({
        id: randomUUID(),
        kind: 'text',
        role: 'assistant',
        text: 'The previous run was interrupted. No portfolio change was committed. You can retry as a new run.',
      });
      await db.transaction(async (tx) => {
        await tx
          .update(t.agentRuns)
          .set({
            status: 'interrupted',
            completeness: 'limited',
            limitReasons: ['PROCESS_INTERRUPTED'],
            finishedAt: new Date().toISOString(),
            continuation: null,
            history,
          })
          .where(eq(t.agentRuns.id, run.id));
        await tx
          .update(t.agentSessions)
          .set({ history, continuation: null })
          .where(eq(t.agentSessions.id, run.sessionId));
        await tx
          .update(t.portfolioPreviews)
          .set({ status: 'REJECTED' })
          .where(
            and(
              eq(t.portfolioPreviews.status, 'PENDING'),
              sql`${t.portfolioPreviews.idempotencyKey} like ${`chat:${run.id}:%`}`,
            ),
          );
      });
    }
  };
  return {
    settings,
    async dailyUsage() {
      // Same UTC boundary and reservation ledger as reserve(); across conversations.
      const [row] = await db
        .select({
          budgetedCost: sql<string>`coalesce(sum(${t.agentRuns.reservedCost}),0) + (select coalesce(sum(cost),0) from research_embedding_usage where agent_run_id is null and created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')`,
          replies: sql<number>`count(*)::int`,
          unpricedReplies: sql<number>`count(*) filter (where ${t.agentRuns.provider} <> 'fixture' and (${t.agentRuns.estimatedCost} is null or ${t.agentRuns.priceVersion} is null))::int`,
        })
        .from(t.agentRuns)
        .where(
          sql`${t.agentRuns.startedAt} >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'`,
        );
      return row!;
    },
    async recover() {
      const client = await pool.connect();
      let held = false;
      try {
        held =
          (
            await client.query<{ locked: boolean }>(
              'select pg_try_advisory_lock(241031,1) as locked',
            )
          ).rows[0]?.locked === true;
        if (held) await recoverHeld();
      } finally {
        if (held) await client.query('select pg_advisory_unlock(241031,1)');
        client.release();
      }
    },
    async reset(context: string) {
      await db.transaction(async (tx) => {
        const result = await tx.execute(
          sql`select pg_try_advisory_xact_lock(241031,1) as locked`,
        );
        if (!(result.rows[0] as { locked: boolean } | undefined)?.locked)
          throw new PortfolioError(
            'AGENT_BUSY',
            'Wait for the active run to finish before starting a new conversation.',
            409,
          );
        const previous = await session(context);
        await tx
          .update(t.agentSessions)
          .set({ context: `archive:${previous.id}` })
          .where(eq(t.agentSessions.id, previous.id));
        await tx.insert(t.agentSessions).values({ context });
      });
    },
    async updateSettings(revision: number, mode?: string, language?: string) {
      await settings();
      const [r] = await db
        .update(t.appSettings)
        .set({
          ...(mode ? { defaultAnalysisMode: mode } : {}),
          ...(language ? { outputLanguage: language } : {}),
          revision: revision + 1,
        })
        .where(
          and(eq(t.appSettings.id, 1), eq(t.appSettings.revision, revision)),
        )
        .returning();
      if (!r)
        throw new PortfolioError(
          'SETTINGS_CONFLICT',
          'Settings changed; refresh and retry.',
          409,
        );
      return r;
    },
    async session(context: string) {
      const s = await session(context);
      const runs = await db
        .select()
        .from(t.agentRuns)
        .where(eq(t.agentRuns.sessionId, s.id))
        .orderBy(desc(t.agentRuns.startedAt))
        .limit(20);
      return {
        id: s.id,
        context: s.context,
        history: s.history as CanonicalItem[],
        draft: s.draft,
        revision: s.revision,
        runs: runs.map(publicRun),
      };
    },
    async draft(context: string, draft: string, revision: number) {
      const s = await session(context);
      const [updated] = await db
        .update(t.agentSessions)
        .set({
          draft,
          revision: revision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(t.agentSessions.id, s.id),
            eq(t.agentSessions.revision, revision),
          ),
        )
        .returning();
      if (!updated)
        throw new PortfolioError(
          'SESSION_CONFLICT',
          'Conversation changed; refresh before saving this draft.',
          409,
        );
      return { revision: updated.revision };
    },
    async claim(input: {
      context: string;
      requestKey: string;
      message: string;
      holdingContext?: { accountKey: string; instrumentKey?: string };
      parentRunId?: string;
      requestedMode?: string;
      requestedLanguage?: string;
      outputLanguage?: string;
      provider: string;
      model: string;
      analysisMode: string;
      policyVersion: string;
      promptVersion: string;
      adapterVersion: string;
      effectiveLimits: Record<string, unknown>;
      portfolioRevision: number;
      priceVersion: string | null;
    }) {
      const fp = fingerprint({
        context: input.context,
        requestKey: input.requestKey,
        message: input.message,
        ...(input.holdingContext
          ? { holdingContext: input.holdingContext }
          : {}),
        parentRunId: input.parentRunId,
        requestedMode: input.requestedMode,
        requestedLanguage: input.requestedLanguage,
      });
      const [old] = await db
        .select()
        .from(t.agentRuns)
        .where(eq(t.agentRuns.requestKey, input.requestKey));
      if (old) {
        if (old.fingerprint !== fp)
          throw new PortfolioError(
            'IDEMPOTENCY_CONFLICT',
            'Request key already used for a different request.',
            409,
          );
        return { run: publicRun(old), lease: null };
      }
      const client = await pool.connect();
      let held = false;
      try {
        const result = await client.query<{ locked: boolean }>(
          'select pg_try_advisory_lock(241031,1) as locked',
        );
        held = result.rows[0]?.locked === true;
        if (!held)
          throw new PortfolioError(
            'AGENT_BUSY',
            'Advisor is already processing a workbook or conversation. Try again when it finishes.',
            409,
          );
        const [repeated] = await db
          .select()
          .from(t.agentRuns)
          .where(eq(t.agentRuns.requestKey, input.requestKey));
        if (repeated) {
          if (repeated.fingerprint !== fp)
            throw new PortfolioError(
              'IDEMPOTENCY_CONFLICT',
              'Request key already used for a different request.',
              409,
            );
          await client.query('select pg_advisory_unlock(241031,1)');
          held = false;
          client.release();
          return { run: publicRun(repeated), lease: null };
        }
        await recoverHeld();
        const s = await session(input.context);
        if (input.parentRunId) {
          const parent = await getRun(input.parentRunId);
          if (parent.sessionId !== s.id || parent.status === 'running')
            throw new PortfolioError(
              'INVALID_PARENT',
              'Follow-up must reference a terminal run in this conversation.',
            );
        }
        const history = [
          ...(s.history as CanonicalItem[]),
          {
            id: randomUUID(),
            kind: 'text' as const,
            role: 'user' as const,
            text: input.message,
            ...(input.holdingContext
              ? { holdingContext: input.holdingContext }
              : {}),
            createdAt: new Date().toISOString(),
          },
        ];
        const id = randomUUID();
        const run = await db.transaction(async (tx) => {
          const [r] = await tx
            .insert(t.agentRuns)
            .values({
              id,
              sessionId: s.id,
              requestKey: input.requestKey,
              fingerprint: fp,
              parentRunId: input.parentRunId ?? null,
              provider: input.provider,
              model: input.model,
              analysisMode: input.analysisMode,
              outputLanguage: input.outputLanguage ?? 'en',
              policyVersion: input.policyVersion,
              promptVersion: input.promptVersion,
              adapterVersion: input.adapterVersion,
              effectiveLimits: input.effectiveLimits,
              portfolioRevision: input.portfolioRevision,
              priceVersion: input.priceVersion,
              history,
              continuation: s.continuation,
            })
            .returning();
          await tx
            .update(t.agentSessions)
            .set({
              history,
              draft: '',
              revision: sql`${t.agentSessions.revision}+1`,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(t.agentSessions.id, s.id));
          return r!;
        });
        return {
          run: publicRun(run),
          lease: {
            history,
            continuation: s.continuation as Continuation | null,
            release: async () => {
              try {
                await client.query('select pg_advisory_unlock(241031,1)');
              } finally {
                client.release();
              }
            },
          },
        };
      } catch (e) {
        if (held) await client.query('select pg_advisory_unlock(241031,1)');
        client.release();
        throw e;
      }
    },
    getRun: async (id: string) => publicRun(await getRun(id)),
    async event(id: string, event: Record<string, unknown>) {
      await db
        .update(t.agentRuns)
        .set({
          events: sql`${t.agentRuns.events} || ${JSON.stringify([{ ...event, at: new Date().toISOString() }])}::jsonb`,
        })
        .where(eq(t.agentRuns.id, id));
    },
    async checkpoint(
      id: string,
      history: CanonicalItem[],
      continuation: Continuation | undefined,
    ) {
      const r = await getRun(id);
      await db.transaction(async (tx) => {
        await tx
          .update(t.agentRuns)
          .set({ history, continuation: continuation ?? null })
          .where(eq(t.agentRuns.id, id));
        await tx
          .update(t.agentSessions)
          .set({
            history,
            continuation: continuation ?? null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(t.agentSessions.id, r.sessionId));
      });
    },
    async tool(
      id: string,
      callId: string,
      args: unknown,
      execute: () => Promise<unknown>,
    ) {
      const fp = fingerprint(args);
      const [old] = await db
        .select()
        .from(t.agentToolCalls)
        .where(
          and(
            eq(t.agentToolCalls.runId, id),
            eq(t.agentToolCalls.callId, callId),
          ),
        );
      if (old) {
        if (old.fingerprint !== fp)
          throw new PortfolioError(
            'TOOL_ID_REUSED',
            'Tool call identifier reused with different arguments.',
          );
        return old.output;
      }
      const output = await execute();
      await db
        .insert(t.agentToolCalls)
        .values({ runId: id, callId, fingerprint: fp, output })
        .onConflictDoNothing();
      return output;
    },
    async reserve(
      id: string,
      cost: string,
      maxRun: string | null,
      daily: string | null,
    ) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(241031,2)`);
        const r = await getRun(id);
        const reserved = new Decimal(r.reservedCost).add(cost);
        if (maxRun && reserved.gt(maxRun))
          throw new PortfolioError(
            'RUN_COST_LIMIT',
            'The estimated run-cost ceiling would be exceeded.',
          );
        const [row] = await tx
          .select({
            total: sql<string>`coalesce(sum(${t.agentRuns.reservedCost}),0) + (select coalesce(sum(cost),0) from research_embedding_usage where agent_run_id is null and created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')`,
          })
          .from(t.agentRuns)
          .where(
            sql`${t.agentRuns.startedAt} >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'`,
          );
        if (daily && new Decimal(row?.total ?? 0).add(cost).gt(daily))
          throw new PortfolioError(
            'DAILY_COST_LIMIT',
            'The daily estimated inference budget is exhausted.',
          );
        await tx
          .update(t.agentRuns)
          .set({ reservedCost: reserved.toFixed() })
          .where(eq(t.agentRuns.id, id));
      });
    },
    async recordUsage(
      id: string,
      usage: { inputTokens: number; outputTokens: number } | null,
      reservation: string,
      actual: string | null,
    ) {
      const r = await getRun(id);
      const previous = r.usage as {
        inputTokens: number;
        outputTokens: number;
        complete: boolean;
      } | null;
      await db
        .update(t.agentRuns)
        .set({
          usage: {
            inputTokens:
              (previous?.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
            outputTokens:
              (previous?.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
            complete: (previous?.complete ?? true) && usage !== null,
          },
          reservedCost:
            actual === null
              ? r.reservedCost
              : new Decimal(r.reservedCost)
                  .sub(reservation)
                  .add(actual)
                  .toFixed(),
          estimatedCost:
            actual === null || previous?.complete === false
              ? null
              : new Decimal(r.estimatedCost ?? 0).add(actual).toFixed(),
        })
        .where(eq(t.agentRuns.id, id));
    },
    async cancel(id: string) {
      await getRun(id);
      await db
        .update(t.agentRuns)
        .set({ cancelRequested: true })
        .where(and(eq(t.agentRuns.id, id), eq(t.agentRuns.status, 'running')));
    },
    async finish(
      id: string,
      status: 'completed' | 'failed' | 'cancelled',
      reason: string | null,
      previewId: string | null,
      terminalEvent?: Record<string, unknown>,
    ) {
      const r = await getRun(id);
      await db.transaction(async (tx) => {
        await tx
          .update(t.agentRuns)
          .set({
            status,
            ...(terminalEvent
              ? {
                  events: sql`${t.agentRuns.events} || ${JSON.stringify([{ ...terminalEvent, at: new Date().toISOString() }])}::jsonb`,
                }
              : {}),
            completeness:
              status === 'completed' && !reason ? 'complete' : 'limited',
            limitReasons: reason ? [reason] : [],
            previewId: status === 'completed' ? previewId : null,
            finishedAt: new Date().toISOString(),
          })
          .where(eq(t.agentRuns.id, id));
        if (status !== 'completed')
          await tx
            .update(t.agentSessions)
            .set({ continuation: null })
            .where(eq(t.agentSessions.id, r.sessionId));
      });
    },
  };
}
export type ChatRepository = ReturnType<typeof createChatRepository>;
