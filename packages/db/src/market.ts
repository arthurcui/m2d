import { createHash } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, desc, lte } from 'drizzle-orm';
import { z } from 'zod';
import { instrumentKey, instrumentSchema, currency } from '@m2d/portfolio';
import {
  MarketError,
  payloadSchema,
  symbolSchema,
  massiveCompletedDate,
  newYorkDate,
  isMarketSourceFailure,
  type MarketProvider,
  type Valuation,
} from '@m2d/market';
import {
  marketObservations as observations,
  marketRefreshes as refreshes,
  valuationSnapshots as snapshots,
} from './schema.js';

export const marketRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quote'), instrument: instrumentSchema }),
  z.object({
    kind: z.literal('bars'),
    symbol: symbolSchema,
    exchange: z.enum(['NASDAQ', 'NYSE', 'AMEX', 'ARCA']).optional(),
  }),
  z.object({ kind: z.literal('fx'), base: currency, quote: currency }),
  z.object({
    kind: z.literal('options'),
    symbol: symbolSchema,
    expiry: z.iso.date(),
  }),
]);
export type MarketRequest = z.infer<typeof marketRequestSchema>;
export function marketSubject(r: MarketRequest) {
  return r.kind === 'quote'
    ? instrumentKey(r.instrument)
    : r.kind === 'fx'
      ? `${r.base}/${r.quote}`
      : r.kind === 'options'
        ? `${r.symbol}:${r.expiry}`
        : `${r.symbol}:${r.exchange ?? 'NASDAQ'}`;
}
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function createMarketRepository(pool: pg.Pool) {
  const db = drizzle(pool);
  async function reserveProviderRequest(
    provider: 'massive' | 'ibkr',
    intervalMs: number,
  ) {
    const reserved = await pool.query(
      `insert into market_provider_limits(provider,next_allowed_at)
       values($1,clock_timestamp()+($2*interval '1 millisecond'))
       on conflict(provider) do update set next_allowed_at=clock_timestamp()+($2*interval '1 millisecond')
       where market_provider_limits.next_allowed_at <= clock_timestamp()
       returning provider`,
      [provider, intervalMs],
    );
    if (reserved.rowCount) return 0;
    const result = await pool.query<{ wait: number }>(
      'select greatest(1,ceil(extract(epoch from (next_allowed_at-clock_timestamp()))*1000))::integer as wait from market_provider_limits where provider=$1',
      [provider],
    );
    return result.rows[0]?.wait ?? intervalMs;
  }
  const reserveMassiveRequest = () => reserveProviderRequest('massive', 13000);
  async function waitForProvider(
    provider: 'massive' | 'ibkr',
    intervalMs: number,
  ) {
    for (;;) {
      const wait = await reserveProviderRequest(provider, intervalMs);
      if (!wait) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return {
    reserveMassiveRequest,
    waitForIbkrRequest: () => waitForProvider('ibkr', 1000),
    async waitForMassiveRequest() {
      // Recheck after sleeping: a reservation belongs to the actual dispatch,
      // never to a queued future slot that could burst after a delayed wakeup.
      for (;;) {
        const wait = await reserveMassiveRequest();
        if (!wait) return;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    },
    async recover() {
      const client = await pool.connect();
      let locked = false;
      try {
        locked =
          (
            await client.query<{ locked: boolean }>(
              'select pg_try_advisory_lock(73032026) as locked',
            )
          ).rows[0]?.locked === true;
        if (locked)
          await drizzle(client)
            .update(refreshes)
            .set({ status: 'FAILED', errorCode: 'REFRESH_INTERRUPTED' })
            .where(eq(refreshes.status, 'PENDING'));
      } finally {
        if (locked) await client.query('select pg_advisory_unlock(73032026)');
        client.release();
      }
    },
    async read(
      provider: string,
      kind: string,
      subject: string,
      at = new Date().toISOString(),
    ) {
      const rows = await db
        .select()
        .from(observations)
        .where(
          and(
            eq(observations.provider, provider),
            eq(observations.kind, kind),
            eq(observations.subject, subject),
            lte(observations.availableAt, at),
          ),
        )
        .orderBy(desc(observations.asOf), desc(observations.availableAt))
        .limit(1);
      const row = rows[0];
      return row
        ? { id: row.id, payload: row.payload, availableAt: row.availableAt }
        : null;
    },
    async status(provider: string) {
      return db
        .select({
          subject: refreshes.subject,
          status: refreshes.status,
          errorCode: refreshes.errorCode,
          startedAt: refreshes.startedAt,
          observationId: refreshes.observationId,
        })
        .from(refreshes)
        .where(eq(refreshes.provider, provider))
        .orderBy(desc(refreshes.startedAt))
        .limit(20);
    },
    async refresh(
      key: string,
      request: MarketRequest,
      provider: MarketProvider,
    ) {
      const fingerprint = hash({ request, provider: provider.id });
      const subject = marketSubject(request);
      const client = await pool.connect();
      const rdb = drizzle(client);
      let locked = false;
      try {
        const lock = await client.query<{ locked: boolean }>(
          'select pg_try_advisory_lock(73032026) as locked',
        );
        locked = lock.rows[0]?.locked === true;
        if (!locked)
          throw new MarketError(
            'MARKET_BUSY',
            'Another market refresh is running. Retry shortly.',
            409,
          );
        const existing = (
          await rdb
            .select()
            .from(refreshes)
            .where(eq(refreshes.requestKey, key))
        )[0];
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new MarketError(
              'IDEMPOTENCY_CONFLICT',
              'This request key belongs to a different refresh.',
              409,
            );
          // Owning the global lock proves a prior PENDING request is no longer
          // executing. Never retry its provider call after an interrupted run.
          if (existing.status === 'PENDING') {
            await rdb
              .update(refreshes)
              .set({ status: 'FAILED', errorCode: 'REFRESH_INTERRUPTED' })
              .where(eq(refreshes.requestKey, key));
            return {
              ...existing,
              status: 'FAILED',
              errorCode: 'REFRESH_INTERRUPTED',
              duplicate: true,
            };
          }
          return { ...existing, duplicate: true };
        }
        if (
          (provider.id === 'twelvedata' || provider.id === 'massive') &&
          (request.kind === 'options' ||
            (provider.id === 'twelvedata' &&
              request.kind === 'quote' &&
              request.instrument.assetType === 'OPTION'))
        )
          throw new MarketError(
            'OPTIONS_UNAVAILABLE',
            'Licensed options data is unavailable in this adapter. Other feeds can still be refreshed.',
          );
        if (['massive', 'ibkr'].includes(provider.id) && request.kind === 'fx')
          throw new MarketError(
            'FX_UNAVAILABLE',
            'FX is not enabled for this provider. Non-USD balances remain unconverted.',
          );
        // Completed-day evidence is reusable across refreshes and restarts.
        // Historical versions stay immutable; new dates create new evidence.
        if (provider.id === 'massive') {
          const cached = (
            await rdb
              .select()
              .from(observations)
              .where(
                and(
                  eq(observations.provider, provider.id),
                  eq(observations.kind, request.kind),
                  eq(observations.subject, subject),
                ),
              )
              .orderBy(desc(observations.asOf))
              .limit(1)
          )[0];
          if (
            cached &&
            newYorkDate(Date.parse(cached.asOf)) ===
              massiveCompletedDate(Date.now())
          ) {
            const saved = (
              await rdb
                .insert(refreshes)
                .values({
                  requestKey: key,
                  fingerprint,
                  provider: provider.id,
                  subject,
                  status: 'SUCCEEDED',
                  observationId: cached.id,
                })
                .returning()
            )[0]!;
            return { ...saved, duplicate: false, cached: true };
          }
        }
        const recent = (
          await rdb
            .select()
            .from(refreshes)
            .where(eq(refreshes.provider, provider.id))
            .orderBy(desc(refreshes.startedAt))
            .limit(1)
        )[0];
        if (
          provider.id !== 'fixture' &&
          recent &&
          Date.now() - Date.parse(recent.startedAt) <
            (recent.status === 'FAILED' &&
            !isMarketSourceFailure(recent.errorCode)
              ? 60000
              : ['massive', 'ibkr'].includes(provider.id)
                ? 0
                : 8000)
        )
          throw new MarketError(
            'MARKET_RATE_LIMIT',
            'Wait before refreshing again: 8 seconds between requests, one minute after a provider failure.',
            429,
          );
        const inserted = (
          await rdb
            .insert(refreshes)
            .values({
              requestKey: key,
              fingerprint,
              provider: provider.id,
              subject,
              status: 'PENDING',
            })
            .returning()
        )[0]!;
        try {
          const response = await (request.kind === 'quote'
            ? provider.quote(request.instrument)
            : request.kind === 'bars'
              ? provider.bars(request.symbol, request.exchange)
              : request.kind === 'fx'
                ? provider.fx(request.base, request.quote)
                : provider.options(request.symbol, request.expiry));
          const payload = payloadSchema.parse(response.payload);
          if (
            payload.kind !== request.kind ||
            (payload.kind === 'quote' &&
              request.kind === 'quote' &&
              instrumentKey(payload.value.instrument) !==
                instrumentKey(request.instrument)) ||
            (payload.kind === 'fx' &&
              request.kind === 'fx' &&
              (payload.value.base !== request.base ||
                payload.value.quote !== request.quote)) ||
            (payload.kind === 'bars' &&
              request.kind === 'bars' &&
              payload.value.some(
                (b) =>
                  b.symbol !== request.symbol ||
                  b.exchange !== (request.exchange ?? 'NASDAQ'),
              )) ||
            (payload.kind === 'options' &&
              request.kind === 'options' &&
              payload.value.some(
                (o) =>
                  o.quote.instrument.underlying !== request.symbol ||
                  o.quote.instrument.expiry !== request.expiry,
              ))
          )
            throw new MarketError(
              'INSTRUMENT_MISMATCH',
              'Provider evidence does not match the requested identity.',
            );
          const all =
            payload.kind === 'bars'
              ? payload.value
              : payload.kind === 'options'
                ? payload.value.map((o) => o.quote)
                : [payload.value];
          if (!all.length)
            throw new MarketError(
              'NO_COVERAGE',
              'Provider returned no completed observations.',
            );
          const now = new Date().toISOString();
          if (
            all.some(
              (e) =>
                Date.parse(e.asOf) > Date.parse(now) ||
                e.provider !== provider.id,
            )
          )
            throw new MarketError(
              'INVALID_MARKET_DATA',
              'Future-dated or mismatched provider evidence was rejected.',
            );
          // Availability belongs to this ingestion, never to provider claims.
          for (const e of all) {
            e.receivedAt = now;
            e.availableAt = now;
          }
          const contentHash = hash({
            provider: provider.id,
            request,
            raw: response.raw,
          });
          const asOf = all
            .map((e) => e.asOf)
            .sort()
            .at(-1)!;
          const saved = await rdb.transaction(async (tx) => {
            await tx
              .insert(observations)
              .values({
                provider: provider.id,
                kind: request.kind,
                subject,
                contentHash,
                asOf,
                receivedAt: now,
                availableAt: now,
                payload,
                raw: response.raw,
              })
              .onConflictDoNothing();
            const row = (
              await tx
                .select({ id: observations.id })
                .from(observations)
                .where(eq(observations.contentHash, contentHash))
            )[0]!;
            await tx
              .update(refreshes)
              .set({ status: 'SUCCEEDED', observationId: row.id })
              .where(eq(refreshes.requestKey, key));
            return row;
          });
          return {
            ...inserted,
            status: 'SUCCEEDED',
            observationId: saved.id,
            duplicate: false,
          };
        } catch (e) {
          const code =
            e instanceof MarketError ? e.code : 'INVALID_MARKET_DATA';
          if (
            ['massive', 'ibkr'].includes(provider.id) &&
            !isMarketSourceFailure(code)
          )
            await client.query(
              "insert into market_provider_limits(provider,next_allowed_at) values($1,clock_timestamp()+interval '60 seconds') on conflict(provider) do update set next_allowed_at=greatest(market_provider_limits.next_allowed_at,excluded.next_allowed_at)",
              [provider.id],
            );
          await rdb
            .update(refreshes)
            .set({ status: 'FAILED', errorCode: code })
            .where(eq(refreshes.requestKey, key));
          return {
            ...inserted,
            status: 'FAILED',
            errorCode: code,
            duplicate: false,
          };
        }
      } finally {
        if (locked) await client.query('select pg_advisory_unlock(73032026)');
        client.release();
      }
    },
    async saveSnapshot(
      key: string,
      revision: number,
      provider: string,
      valuation: Valuation,
      ids: string[],
    ) {
      await db
        .insert(snapshots)
        .values({
          requestKey: key,
          portfolioRevision: revision,
          provider,
          baseCurrency: valuation.baseCurrency,
          computedAt: valuation.computedAt,
          valuation,
          observationIds: ids,
        })
        .onConflictDoNothing();
      return (
        await db.select().from(snapshots).where(eq(snapshots.requestKey, key))
      )[0]!;
    },
    async snapshots(provider: string) {
      return db
        .select()
        .from(snapshots)
        .where(eq(snapshots.provider, provider))
        .orderBy(desc(snapshots.computedAt))
        .limit(100);
    },
  };
}
export type MarketRepository = ReturnType<typeof createMarketRepository>;
