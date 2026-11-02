import type pg from 'pg';
import { createHash } from 'node:crypto';
import { RiskError, type PlanInput, type validatePlan } from '@m2d/risk';
export function createRiskRepository(pool: pg.Pool) {
  return {
    async replay(input: PlanInput) {
      const row = (
        await pool.query<{
          id: string;
          fingerprint: string;
          assessment: ReturnType<typeof validatePlan>;
        }>(
          'select id,fingerprint,assessment from trade_plans where idempotency_key=$1',
          [input.idempotencyKey],
        )
      ).rows[0];
      if (!row) return null;
      if (
        row.fingerprint !==
        createHash('sha256').update(JSON.stringify(input)).digest('hex')
      )
        throw new RiskError(
          'IDEMPOTENCY_CONFLICT',
          'This request ID was already used for another plan.',
          409,
        );
      return { id: row.id, reused: true, assessment: row.assessment };
    },
    async list() {
      return (
        await pool.query(
          'select id,portfolio_revision,created_at,status,input,assessment from trade_plans order by created_at desc limit 100',
        )
      ).rows as Array<{
        id: string;
        portfolio_revision: number;
        created_at: string;
        status: string;
        input: PlanInput;
        assessment: ReturnType<typeof validatePlan>;
      }>;
    },
    async save(input: PlanInput, assessment: ReturnType<typeof validatePlan>) {
      const fingerprint = createHash('sha256')
          .update(JSON.stringify(input))
          .digest('hex'),
        client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [
          'plan:' + input.idempotencyKey,
        ]);
        const old = (
          await client.query<{ id: string; fingerprint: string }>(
            'select id,fingerprint from trade_plans where idempotency_key=$1',
            [input.idempotencyKey],
          )
        ).rows[0];
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new RiskError(
              'IDEMPOTENCY_CONFLICT',
              'This request ID was already used for another plan.',
              409,
            );
          await client.query('commit');
          return { id: old.id, reused: true };
        }
        const revision =
          (
            await client.query<{ revision: number }>(
              'select revision from portfolio_revision for share',
            )
          ).rows[0]?.revision ?? 0;
        if (revision !== input.portfolioRevision)
          throw new RiskError(
            'STALE_PORTFOLIO',
            'Portfolio changed. Review the plan against current holdings.',
            409,
          );
        const row = (
          await client.query<{ id: string }>(
            "insert into trade_plans(idempotency_key,fingerprint,portfolio_revision,status,input,assessment) values($1,$2,$3,'WATCH_ONLY',$4,$5) returning id",
            [
              input.idempotencyKey,
              fingerprint,
              revision,
              JSON.stringify(input),
              JSON.stringify(assessment),
            ],
          )
        ).rows[0]!;
        await client.query('commit');
        return { id: row.id, reused: false };
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
export type RiskRepository = ReturnType<typeof createRiskRepository>;
