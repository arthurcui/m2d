import { randomUUID, createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { eq, asc, desc, gt, and } from 'drizzle-orm';
import {
  stateSchema,
  emptyState,
  applyOperation,
  replacement,
  diff,
  warnings,
  instrumentKey,
  PortfolioError,
  fail,
  type State,
  type Operation,
  confirmSchema,
  type WorkbookMapping,
  type ImportSource,
} from '@m2d/portfolio';
import * as tables from './schema.js';

// PostgreSQL jsonb reorders object keys. Hash canonical values, never driver key order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export function createPortfolioRepository(pool: pg.Pool) {
  const db = drizzle(pool);
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  const lock = async (tx: Tx) => {
    await tx
      .insert(tables.portfolioRevision)
      .values({ id: 1 })
      .onConflictDoNothing();
    return (
      await tx
        .select()
        .from(tables.portfolioRevision)
        .where(eq(tables.portfolioRevision.id, 1))
        .for('update')
    )[0]!;
  };
  const load = async (tx: Tx): Promise<State> => {
    const a = await tx
      .select()
      .from(tables.accounts)
      .orderBy(asc(tables.accounts.accountKey));
    const p = await tx
      .select({
        position: tables.positionProjection,
        instrument: tables.instruments.definition,
      })
      .from(tables.positionProjection)
      .innerJoin(
        tables.instruments,
        eq(tables.positionProjection.instrumentId, tables.instruments.id),
      )
      .orderBy(
        asc(tables.positionProjection.accountKey),
        asc(tables.positionProjection.instrumentId),
      );
    const c = await tx
      .select()
      .from(tables.cashProjection)
      .orderBy(
        asc(tables.cashProjection.accountKey),
        asc(tables.cashProjection.currency),
      );
    return stateSchema.parse({
      accounts: a,
      positions: p.map(({ position, instrument }) => ({
        accountKey: position.accountKey,
        quantity: position.quantity,
        averageCost: position.averageCost,
        quality: position.quality,
        notes: position.notes,
        ...(position.description !== null
          ? { description: position.description }
          : {}),
        ...(position.optionGroup !== null
          ? { optionGroup: position.optionGroup }
          : {}),
        ...(position.transactionDate !== null
          ? { transactionDate: position.transactionDate }
          : {}),
        instrument,
      })),
      cash: c,
    });
  };
  const save = async (tx: Tx, state: State) => {
    for (const a of state.accounts)
      await tx
        .insert(tables.accounts)
        .values(a)
        .onConflictDoUpdate({ target: tables.accounts.accountKey, set: a });
    for (const p of state.positions) {
      const i = p.instrument;
      await tx
        .insert(tables.instruments)
        .values({
          id: instrumentKey(i),
          definition: i,
          assetType: i.assetType,
          symbol: i.symbol,
          exchange: i.exchange,
          currency: i.currency,
          multiplier: i.multiplier,
        })
        .onConflictDoNothing();
    }
    // Derived projections only. Baselines, events, imports and audit rows are append-only.
    await tx.delete(tables.positionProjection);
    await tx.delete(tables.cashProjection);
    if (state.positions.length)
      await tx.insert(tables.positionProjection).values(
        state.positions.map(({ instrument, ...p }) => ({
          ...p,
          instrumentId: instrumentKey(instrument),
        })),
      );
    if (state.cash.length)
      await tx.insert(tables.cashProjection).values(state.cash);
  };
  const temporal = (effectiveAt: string, last: string | null) => {
    if (new Date(effectiveAt).getTime() > Date.now())
      fail('FUTURE_EFFECTIVE_TIME', 'Effective time cannot be in the future.');
    if (last && new Date(effectiveAt) < new Date(last))
      fail(
        'BACKDATED_CHANGE',
        'Effective time precedes the latest confirmed boundary. Record an explicit current correction or replacement baseline.',
      );
  };
  const stage = async (
    tx: Tx,
    input: {
      key: string;
      fingerprint: string;
      expectedRevision: number;
      effectiveAt: string;
      operation?: Operation;
      state?: State;
      importId?: string;
      restoresBaselineId?: string;
    },
  ) => {
    const rev = await lock(tx);
    const old = (
      await tx
        .select()
        .from(tables.portfolioPreviews)
        .where(eq(tables.portfolioPreviews.idempotencyKey, input.key))
    )[0];
    if (old) {
      if (old.hash !== input.fingerprint)
        fail(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used with different content.',
          409,
        );
      return old;
    }
    if (rev.revision !== input.expectedRevision)
      fail(
        'REVISION_CONFLICT',
        'Portfolio changed. Reload and create a new preview.',
        409,
      );
    temporal(input.effectiveAt, rev.effectiveAt);
    if (input.operation?.correctionOf) {
      const target = (
        await tx
          .select()
          .from(tables.portfolioEvents)
          .where(eq(tables.portfolioEvents.id, input.operation.correctionOf))
      )[0];
      if (!target)
        fail('NOT_FOUND', 'Correction must reference an existing event.', 404);
    }
    const current = await load(tx);
    const result = input.operation
      ? applyOperation(current, input.operation)
      : { state: replacement(current, input.state!), realized: [] };
    const changes = diff(current, result.state);
    if (
      !changes.length &&
      input.operation &&
      input.operation.kind !== 'NOTE_ONLY'
    )
      fail('NO_CHANGES', 'This proposal does not change portfolio state.');
    const now = new Date();
    const preview = {
      id: randomUUID(),
      idempotencyKey: input.key,
      hash: input.fingerprint,
      expectedRevision: rev.revision,
      kind: input.operation ? 'EVENT' : 'BASELINE',
      status: 'PENDING',
      createdAt: now.toISOString(),
      expiresAt: new Date(+now + 15 * 60 * 1000).toISOString(),
      effectiveAt: input.effectiveAt,
      importId: input.importId ?? null,
      restoresBaselineId: input.restoresBaselineId ?? null,
      operation: input.operation ?? null,
      proposed: result.state,
      changes,
      warnings: [
        ...(input.operation &&
        'transactionDate' in input.operation &&
        input.operation.transactionDate
          ? [
              `Reported trade date: ${input.operation.transactionDate}. This applies a newly reported trade to current holdings and cash; it does not rewrite earlier snapshots. Confirm it is not already included in your current portfolio. Any closing P&L uses the currently recorded basis, not a reconstructed historical basis.`,
            ]
          : []),
        ...(!input.operation
          ? [
              'FULL REPLACEMENT: all unlisted positions and currencies become zero; unlisted accounts become inactive. Imported cost basis is an estimate; prior realized P&L is unknown.',
            ]
          : []),
        ...warnings(result.state),
      ],
      realized: result.realized,
      confirmedRevision: null,
    };
    await tx.insert(tables.portfolioPreviews).values(preview);
    return preview;
  };
  const repository = {
    async accountAliases() {
      return db.select().from(tables.portfolioAccountAliases);
    },
    async importMemories() {
      return db
        .select()
        .from(tables.portfolioImportMemories)
        .orderBy(desc(tables.portfolioImportMemories.createdAt))
        .limit(100);
    },
    async runImportParse(
      input: {
        importId: string;
        requestKey: string;
        provider: string;
        model: string;
        request: unknown;
        fingerprintData: unknown;
        retry: boolean;
      },
      generate: () => Promise<unknown>,
    ) {
      const client = await pool.connect();
      let locked = false;
      try {
        locked = (
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(241031, 1) AS locked',
          )
        ).rows[0]!.locked;
        if (!locked)
          fail(
            'AI_BUSY',
            'A workbook is already being parsed. Please wait before retrying.',
            409,
          );
        const connection = drizzle(client),
          table = tables.portfolioImportRuns;
        const fingerprint = hash({
          importId: input.importId,
          provider: input.provider,
          model: input.model,
          data: input.fingerprintData,
        });
        const sameKey = (
          await connection
            .select()
            .from(table)
            .where(eq(table.requestKey, input.requestKey))
        )[0];
        if (sameKey && sameKey.fingerprint !== fingerprint)
          fail(
            'IDEMPOTENCY_CONFLICT',
            'This parsing request key was already used for different input.',
            409,
          );
        const previous = await connection
          .select()
          .from(table)
          .where(eq(table.fingerprint, fingerprint))
          .orderBy(desc(table.createdAt));
        let cached = sameKey ?? previous[0];
        if (cached?.status === 'RUNNING') {
          cached = (
            await connection
              .update(table)
              .set({
                status: 'FAILED',
                finishedAt: new Date().toISOString(),
                errorCode: 'AI_INTERRUPTED',
                errorMessage:
                  'The previous parsing process was interrupted. Retry explicitly; usage may already have been charged.',
              })
              .where(eq(table.id, cached.id))
              .returning()
          )[0]!;
        }
        if (
          cached &&
          (sameKey || cached.status === 'COMPLETED' || !input.retry)
        )
          return cached;
        if (previous.length >= 3)
          fail(
            'AI_RETRY_LIMIT',
            'Three parsing attempts were already made for this input. Clarify the workbook details before another attempt.',
            429,
          );
        const run = (
          await connection
            .insert(table)
            .values({
              id: randomUUID(),
              importId: input.importId,
              requestKey: input.requestKey,
              fingerprint,
              provider: input.provider,
              model: input.model,
              createdAt: new Date().toISOString(),
              status: 'RUNNING',
              request: input.request,
            })
            .returning()
        )[0]!;
        try {
          const response = await generate();
          return (
            await connection
              .update(table)
              .set({
                status: 'COMPLETED',
                finishedAt: new Date().toISOString(),
                response,
              })
              .where(eq(table.id, run.id))
              .returning()
          )[0]!;
        } catch (error) {
          return (
            await connection
              .update(table)
              .set({
                status: 'FAILED',
                finishedAt: new Date().toISOString(),
                errorCode:
                  error instanceof PortfolioError ? error.code : 'AI_FAILED',
                errorMessage:
                  error instanceof PortfolioError
                    ? error.message
                    : 'AI parsing failed. No portfolio changes were made.',
              })
              .where(eq(table.id, run.id))
              .returning()
          )[0]!;
        }
      } finally {
        if (locked)
          await client
            .query('SELECT pg_advisory_unlock(241031, 1)')
            .catch(() => undefined);
        client.release();
      }
    },
    async importSource(id: string) {
      const record = (
        await db
          .select()
          .from(tables.portfolioImports)
          .where(eq(tables.portfolioImports.id, id))
      )[0];
      if (!record) fail('NOT_FOUND', 'Import not found.', 404);
      return {
        bytes: Buffer.from(record.originalBase64, 'base64'),
        effectiveAt: record.effectiveAt,
      };
    },
    async mapImport(
      id: string,
      input: {
        expectedRevision: number;
        mapping: WorkbookMapping;
        state: State | null;
        errors: unknown[];
        sources: ImportSource[];
        warnings: string[];
        memory?: { signature: string } & Record<string, unknown>;
      },
    ) {
      return db.transaction(async (tx) => {
        const rev = await lock(tx);
        const original = (
          await tx
            .select()
            .from(tables.portfolioImports)
            .where(eq(tables.portfolioImports.id, id))
        )[0];
        if (!original) fail('NOT_FOUND', 'Import not found.', 404);
        const previous = (
          await tx
            .select()
            .from(tables.portfolioPreviews)
            .where(eq(tables.portfolioPreviews.importId, id))
            .orderBy(desc(tables.portfolioPreviews.createdAt))
        )[0];
        const fingerprint = hash({
          file: original.hash,
          mapping: input.mapping,
        });
        if (previous?.status === 'CONFIRMED') {
          if (previous.hash !== fingerprint)
            fail(
              'IMPORT_ALREADY_CONFIRMED',
              'This workbook was already confirmed. Restore a baseline or submit a corrected workbook; it cannot be imported twice with different mappings.',
              409,
            );
          return { id, errors: [], preview: previous, sources: input.sources };
        }
        if (rev.revision !== input.expectedRevision)
          fail(
            'REVISION_CONFLICT',
            'Portfolio changed. Reload before reviewing this import again.',
            409,
          );
        if (
          previous?.status === 'PENDING' &&
          previous.hash === fingerprint &&
          previous.expectedRevision === rev.revision &&
          new Date(previous.expiresAt) > new Date()
        )
          return {
            id,
            errors: input.errors,
            preview: previous,
            sources: input.sources,
          };
        await tx
          .update(tables.portfolioPreviews)
          .set({ status: 'REJECTED' })
          .where(
            and(
              eq(tables.portfolioPreviews.importId, id),
              eq(tables.portfolioPreviews.status, 'PENDING'),
            ),
          );
        const preview = input.state
          ? await stage(tx, {
              key: `mapping:${id}:${randomUUID()}`,
              fingerprint,
              expectedRevision: input.expectedRevision,
              effectiveAt: original.effectiveOnConfirmation
                ? new Date().toISOString()
                : original.effectiveAt,
              state: input.state,
              importId: id,
            })
          : null;
        if (preview) {
          preview.warnings = [...input.warnings, ...preview.warnings];
          await tx
            .update(tables.portfolioPreviews)
            .set({ warnings: preview.warnings })
            .where(eq(tables.portfolioPreviews.id, preview.id));
        }
        await tx.insert(tables.portfolioImportMappings).values({
          id: randomUUID(),
          importId: id,
          createdAt: new Date().toISOString(),
          config: input.mapping,
          errors: input.errors,
          sources: input.sources,
          warnings: input.warnings,
          normalized: input.state,
          previewId: preview?.id ?? null,
          memory: input.memory ?? null,
        });
        return { id, errors: input.errors, preview, sources: input.sources };
      });
    },
    async overview() {
      return db.transaction(async (tx) => {
        const revision = await lock(tx);
        return {
          revision: revision.revision,
          effectiveAt: revision.effectiveAt,
          baselineId: revision.baselineId,
          state: await load(tx),
        };
      });
    },
    async preview(input: {
      expectedRevision: number;
      idempotencyKey: string;
      operation: Operation;
    }) {
      return db.transaction((tx) =>
        stage(tx, {
          key: input.idempotencyKey,
          fingerprint: hash(input),
          expectedRevision: input.expectedRevision,
          effectiveAt: input.operation.effectiveAt,
          operation: input.operation,
        }),
      );
    },
    async importWorkbook(input: {
      hash: string;
      bytes: Buffer;
      state: State | null;
      errors: unknown[];
      effectiveAt?: string | undefined;
      expectedRevision: number;
      templateVersion: 1;
    }) {
      return db.transaction(async (tx) => {
        const revision = await lock(tx);
        let record = (
          await tx
            .select()
            .from(tables.portfolioImports)
            .where(eq(tables.portfolioImports.hash, input.hash))
        )[0];
        if (
          record &&
          input.effectiveAt !== undefined &&
          new Date(record.effectiveAt).getTime() !==
            new Date(input.effectiveAt).getTime()
        )
          fail(
            'IDEMPOTENCY_CONFLICT',
            'Identical workbook already staged with a different effective time. Use its original import or a baseline restore.',
            409,
          );
        if (!record) {
          record = {
            id: randomUUID(),
            hash: input.hash,
            originalBase64: input.bytes.toString('base64'),
            templateVersion: 1,
            effectiveAt: input.effectiveAt ?? new Date().toISOString(),
            effectiveOnConfirmation: input.effectiveAt === undefined,
            createdAt: new Date().toISOString(),
            errors: input.errors,
            normalized: input.state,
          };
          await tx.insert(tables.portfolioImports).values(record);
        }
        let preview = null;
        if (record.normalized) {
          // Same file always identifies the same staged import; refresh only expired/conflicted proposals.
          const previous = (
            await tx
              .select()
              .from(tables.portfolioPreviews)
              .where(eq(tables.portfolioPreviews.importId, record.id))
              .orderBy(desc(tables.portfolioPreviews.createdAt))
          )[0];
          if (
            previous?.status === 'CONFIRMED' ||
            (previous?.status === 'PENDING' &&
              previous.expectedRevision === revision.revision &&
              new Date(previous.expiresAt) > new Date())
          )
            preview = previous;
          else
            preview = await stage(tx, {
              key: `import:${record.id}:${randomUUID()}`,
              fingerprint: record.hash,
              expectedRevision: input.expectedRevision,
              effectiveAt: record.effectiveOnConfirmation
                ? new Date().toISOString()
                : record.effectiveAt,
              state: record.normalized,
              importId: record.id,
            });
        }
        if (!record.normalized) {
          const previous = (
            await tx
              .select()
              .from(tables.portfolioPreviews)
              .where(eq(tables.portfolioPreviews.importId, record.id))
              .orderBy(desc(tables.portfolioPreviews.createdAt))
              .limit(1)
          )[0];
          if (
            previous?.status === 'CONFIRMED' ||
            (previous?.status === 'PENDING' &&
              new Date(previous.expiresAt) > new Date())
          )
            preview = previous;
        }
        return {
          id: record.id,
          hash: record.hash,
          errors: record.errors,
          preview,
        };
      });
    },
    async getPreview(id: string) {
      const p = (
        await db
          .select()
          .from(tables.portfolioPreviews)
          .where(eq(tables.portfolioPreviews.id, id))
      )[0];
      return p ?? fail('NOT_FOUND', 'Preview not found.', 404);
    },
    async getImport(id: string) {
      const record = (
        await db
          .select()
          .from(tables.portfolioImports)
          .where(eq(tables.portfolioImports.id, id))
      )[0];
      if (!record) fail('NOT_FOUND', 'Import not found.', 404);
      const interpretation = (
        await db
          .select()
          .from(tables.portfolioImportMappings)
          .where(eq(tables.portfolioImportMappings.importId, id))
          .orderBy(desc(tables.portfolioImportMappings.createdAt))
          .limit(1)
      )[0];
      const p = (
        await db
          .select()
          .from(tables.portfolioPreviews)
          .where(eq(tables.portfolioPreviews.importId, id))
          .orderBy(desc(tables.portfolioPreviews.createdAt))
      )[0];
      return {
        id: record.id,
        hash: record.hash,
        errors: interpretation?.errors ?? record.errors,
        mapping: interpretation?.config ?? null,
        sources: interpretation?.sources ?? [],
        preview: p ?? null,
      };
    },
    async confirm(id: string, input: ReturnType<typeof confirmSchema.parse>) {
      input = confirmSchema.parse(input);
      const result = await db.transaction(async (tx) => {
        const rev = await lock(tx);
        const p = (
          await tx
            .select()
            .from(tables.portfolioPreviews)
            .where(eq(tables.portfolioPreviews.id, id))
        )[0];
        if (!p) fail('NOT_FOUND', 'Preview not found.', 404);
        if (p.idempotencyKey.startsWith('chat:')) {
          const runId = p.idempotencyKey.split(':')[1]!;
          const [run] = await tx
            .select()
            .from(tables.agentRuns)
            .where(eq(tables.agentRuns.id, runId));
          if (!run || run.status !== 'completed' || run.previewId !== id)
            fail(
              'AGENT_PREVIEW_NOT_READY',
              'This Agent run did not finish successfully. Its preview cannot be confirmed.',
              409,
            );
        }
        if (p.expectedRevision !== input.expectedRevision)
          fail(
            'REVISION_CONFLICT',
            'Confirmation revision does not match this preview.',
            409,
          );
        if (p.kind === 'BASELINE' && !input.fullReplacementAcknowledged)
          fail(
            'CONFIRMATION_REQUIRED',
            'Explicitly acknowledge full-state replacement.',
          );
        if (p.status === 'CONFIRMED')
          return { revision: p.confirmedRevision!, duplicate: true };
        if (
          p.operation &&
          'transactionDate' in p.operation &&
          p.operation.transactionDate &&
          !input.tradeNotAlreadyIncluded
        )
          fail(
            'TRADE_INCLUSION_CONFIRMATION_REQUIRED',
            'Confirm that this reported trade is not already included in current holdings or cash. If it is already included, do not apply it again.',
          );
        if (p.status !== 'PENDING')
          fail(
            'PREVIEW_NOT_PENDING',
            `Preview is ${p.status.toLowerCase()}. Create a new preview.`,
            409,
          );
        const failure =
          new Date(p.expiresAt) <= new Date()
            ? 'EXPIRED'
            : rev.revision !== p.expectedRevision
              ? 'CONFLICT'
              : null;
        if (failure) {
          await tx
            .update(tables.portfolioPreviews)
            .set({ status: failure })
            .where(eq(tables.portfolioPreviews.id, id));
          return new PortfolioError(
            failure === 'EXPIRED' ? 'PREVIEW_EXPIRED' : 'REVISION_CONFLICT',
            'Preview expired or portfolio changed; create a fresh preview.',
            409,
          );
        }
        const imported = p.importId
          ? (
              await tx
                .select()
                .from(tables.portfolioImports)
                .where(eq(tables.portfolioImports.id, p.importId))
            )[0]
          : undefined;
        const effectiveAt =
          imported?.effectiveOnConfirmation ||
          p.idempotencyKey.startsWith('chat:')
            ? new Date().toISOString()
            : p.effectiveAt;
        if (p.operation && p.idempotencyKey.startsWith('chat:'))
          p.operation = { ...p.operation, effectiveAt };
        temporal(effectiveAt, rev.effectiveAt);
        const next = rev.revision + 1,
          recordId = randomUUID(),
          availableAt = new Date().toISOString();
        // Recompute, rather than trusting a mutable client-provided projection.
        const current = await load(tx);
        const computed = p.operation
          ? applyOperation(current, p.operation).state
          : stateSchema.parse(p.proposed);
        if (hash(diff(current, computed)) !== hash(p.changes))
          fail(
            'PREVIEW_INTEGRITY',
            'Preview contents no longer match the ledger.',
            409,
          );
        if (p.kind === 'BASELINE')
          await tx.insert(tables.portfolioBaselines).values({
            id: recordId,
            revision: next,
            effectiveAt,
            availableAt,
            previewId: p.id,
            snapshot: computed,
            importId: p.importId,
            restoresBaselineId: p.restoresBaselineId,
          });
        else
          await tx.insert(tables.portfolioEvents).values({
            id: recordId,
            revision: next,
            baselineId: rev.baselineId,
            effectiveAt,
            availableAt,
            previewId: p.id,
            operation: p.operation!,
            realized: p.realized,
          });
        await save(tx, computed);
        await tx.insert(tables.portfolioChangeLog).values({
          id: randomUUID(),
          revision: next,
          kind: p.kind,
          recordId,
          previewId: p.id,
          effectiveAt,
          availableAt,
          changes: p.changes,
          note:
            (p.operation &&
            'transactionDate' in p.operation &&
            p.operation.transactionDate
              ? `Trade date: ${p.operation.transactionDate}. ${p.operation.note}`
              : p.operation?.note) ??
            (p.restoresBaselineId
              ? 'Confirmed baseline restore'
              : 'Confirmed full Excel replacement'),
        });
        await tx
          .update(tables.portfolioRevision)
          .set({
            revision: next,
            effectiveAt,
            baselineId: p.kind === 'BASELINE' ? recordId : rev.baselineId,
          })
          .where(eq(tables.portfolioRevision.id, 1));
        if (p.importId) {
          const interpretation = (
            await tx
              .select()
              .from(tables.portfolioImportMappings)
              .where(eq(tables.portfolioImportMappings.previewId, p.id))
              .orderBy(desc(tables.portfolioImportMappings.createdAt))
          )[0];
          for (const decision of interpretation?.config.accountDecisions ??
            []) {
            const table = interpretation!.config.tables.find(
              (t) => t.sheet === decision.sheet,
            );
            const accountKey = table?.defaults.AccountKey;
            if (accountKey)
              await tx
                .insert(tables.portfolioAccountAliases)
                .values({
                  sheetName: decision.sheet.trim().toLowerCase(),
                  accountKey,
                  updatedAt: availableAt,
                  sourceImportId: p.importId,
                })
                .onConflictDoUpdate({
                  target: tables.portfolioAccountAliases.sheetName,
                  set: {
                    accountKey,
                    updatedAt: availableAt,
                    sourceImportId: p.importId,
                  },
                });
          }
          const memory = interpretation?.memory;
          if (
            memory &&
            typeof memory === 'object' &&
            'signature' in memory &&
            typeof memory.signature === 'string'
          )
            await tx.insert(tables.portfolioImportMemories).values({
              id: randomUUID(),
              signature: memory.signature,
              createdAt: availableAt,
              sourceImportId: p.importId,
              profile: memory,
            });
        }
        await tx
          .update(tables.portfolioPreviews)
          .set({
            status: 'CONFIRMED',
            confirmedRevision: next,
            effectiveAt,
            operation: p.operation,
          })
          .where(eq(tables.portfolioPreviews.id, id));
        return { revision: next, duplicate: false };
      });
      if (result instanceof PortfolioError) throw result;
      return result;
    },
    async reject(id: string) {
      return db.transaction(async (tx) => {
        await lock(tx);
        const p = (
          await tx
            .select()
            .from(tables.portfolioPreviews)
            .where(eq(tables.portfolioPreviews.id, id))
        )[0];
        if (!p) fail('NOT_FOUND', 'Preview not found.', 404);
        if (p.status === 'CONFIRMED')
          fail(
            'PREVIEW_NOT_PENDING',
            'A confirmed change cannot be cancelled. Create a new correction.',
            409,
          );
        await tx
          .update(tables.portfolioPreviews)
          .set({ status: 'REJECTED' })
          .where(eq(tables.portfolioPreviews.id, id));
      });
    },
    async history(accountKey?: string) {
      const rows = await db
        .select({
          log: tables.portfolioChangeLog,
          operation: tables.portfolioEvents.operation,
          realized: tables.portfolioEvents.realized,
        })
        .from(tables.portfolioChangeLog)
        .leftJoin(
          tables.portfolioEvents,
          eq(tables.portfolioChangeLog.recordId, tables.portfolioEvents.id),
        )
        .orderBy(desc(tables.portfolioChangeLog.revision));
      return rows
        .map(({ log, operation, realized }) => ({
          ...log,
          accountKey:
            operation && 'accountKey' in operation
              ? operation.accountKey
              : null,
          realized: realized ?? [],
        }))
        .filter(
          (r) =>
            !accountKey ||
            r.accountKey === accountKey ||
            r.changes.some((c) => c.key.split(':')[1] === accountKey),
        );
    },
    async restore(
      id: string,
      input: {
        expectedRevision: number;
        idempotencyKey: string;
        effectiveAt: string;
      },
    ) {
      return db.transaction(async (tx) => {
        const baseline = (
          await tx
            .select()
            .from(tables.portfolioBaselines)
            .where(eq(tables.portfolioBaselines.id, id))
        )[0];
        if (!baseline) fail('NOT_FOUND', 'Baseline not found.', 404);
        return stage(tx, {
          key: input.idempotencyKey,
          fingerprint: hash({ id, ...input }),
          expectedRevision: input.expectedRevision,
          effectiveAt: input.effectiveAt,
          state: baseline.snapshot,
          restoresBaselineId: id,
        });
      });
    },
    async replay() {
      return db.transaction(async (tx) => {
        await lock(tx);
        const base = (
          await tx
            .select()
            .from(tables.portfolioBaselines)
            .orderBy(desc(tables.portfolioBaselines.revision))
            .limit(1)
        )[0];
        let state = base?.snapshot ?? emptyState();
        const events = await tx
          .select()
          .from(tables.portfolioEvents)
          .where(gt(tables.portfolioEvents.revision, base?.revision ?? 0))
          .orderBy(asc(tables.portfolioEvents.revision));
        for (const e of events)
          state = applyOperation(state, e.operation).state;
        return stateSchema.parse(state);
      });
    },
  };
  return repository;
}
export type PortfolioRepository = ReturnType<typeof createPortfolioRepository>;
