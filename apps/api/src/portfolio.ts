import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import type { PortfolioRepository } from '@m2d/db';
import { parseWorkbookRequest, type WorkbookAi } from './workbook-ai.js';
import {
  previewRequestSchema,
  confirmSchema,
  timestamp,
  PortfolioError,
  warnings,
  workbookMappingSchema,
} from '@m2d/portfolio';
import {
  parseWorkbook,
  workbook,
  MAX_UPLOAD,
  inspectWorkbook,
  resolveWorkbook,
} from '@m2d/ingestion';

export async function portfolioRoutes(
  app: FastifyInstance,
  {
    repository: r,
    workbookAi,
  }: { repository: PortfolioRepository; workbookAi: WorkbookAi },
) {
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD, files: 1, fields: 5, parts: 6 },
  });
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  const envelope = (data: unknown, revision?: number) => ({
    data,
    meta: {
      version: 1,
      source: 'self-reported',
      asOf: new Date().toISOString(),
      revision: revision ?? null,
      dataQuality: 'SELF_REPORTED',
      historicalPerformance: 'UNKNOWN',
      taxCostBasis: 'NOT_ESTABLISHED',
    },
  });
  // No CORS is enabled. All browser mutations must come through the same-origin web proxy.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'POST' && req.headers.origin)
      return reply.code(403).send({
        error: {
          code: 'ORIGIN_REJECTED',
          message: 'Use the local web application for browser mutations.',
        },
      });
  });
  app.get('/api/v1/accounts', async () => {
    const v = await r.overview();
    return envelope(v.state.accounts, v.revision);
  });
  app.get('/api/v1/portfolio/overview', async () => {
    const v = await r.overview();
    return envelope({ ...v, warnings: warnings(v.state) }, v.revision);
  });
  for (const kind of ['positions', 'cash'] as const)
    app.get(`/api/v1/portfolio/${kind}`, async (req) => {
      const query = z
        .object({ accountKey: z.string().optional() })
        .parse(req.query);
      const v = await r.overview();
      return envelope(
        v.state[kind].filter(
          (x) => !query.accountKey || x.accountKey === query.accountKey,
        ),
        v.revision,
      );
    });
  app.get('/api/v1/portfolio/history', async () => envelope(await r.history()));
  app.get('/api/v1/portfolio/accounts/:id/history', async (req) =>
    envelope(
      await r.history(
        z.object({ id: z.string().min(1).max(64) }).parse(req.params).id,
      ),
    ),
  );
  app.get('/api/v1/portfolio/template', async (_req, reply) =>
    reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'Content-Disposition',
        'attachment; filename="m2d-portfolio-v1.xlsx"',
      )
      .send(await workbook()),
  );
  app.post('/api/v1/portfolio/changes/preview', async (req) =>
    envelope(await r.preview(previewRequestSchema.parse(req.body))),
  );
  app.get('/api/v1/portfolio/changes/:id/preview', async (req) =>
    envelope(await r.getPreview(id(req.params))),
  );
  app.post('/api/v1/portfolio/changes/:id/confirm', async (req) => {
    const result = await r.confirm(
      id(req.params),
      confirmSchema.parse(req.body),
    );
    return envelope(result, result.revision);
  });
  app.post('/api/v1/portfolio/changes/:id/reject', async (req) => {
    await r.reject(id(req.params));
    return envelope({ rejected: true });
  });
  app.post('/api/v1/portfolio/imports', async (req) => {
    const fields: Record<string, string> = {};
    let bytes: Buffer | undefined;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (
          part.fieldname !== 'file' ||
          !part.filename.toLowerCase().endsWith('.xlsx')
        )
          throw new PortfolioError(
            'INVALID_WORKBOOK',
            'Upload one .xlsx file in the file field.',
          );
        bytes = await part.toBuffer();
        if (part.file.truncated)
          throw new PortfolioError(
            'UPLOAD_TOO_LARGE',
            'Workbook limit is 2 MiB.',
            413,
          );
      } else {
        if (
          typeof part.value !== 'string' ||
          fields[part.fieldname] !== undefined
        )
          throw new PortfolioError(
            'INVALID_REQUEST',
            'Invalid duplicate upload field.',
          );
        fields[part.fieldname] = part.value;
      }
    }
    if (!bytes)
      throw new PortfolioError('INVALID_WORKBOOK', 'Select an .xlsx workbook.');
    const metadata = z
      .object({
        templateVersion: z.literal('1'),
        mode: z.enum(['auto', 'flexible']).default('auto'),
        effectiveAt: timestamp.optional(),
        expectedRevision: z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .pipe(z.number().int().nonnegative()),
      })
      .strict()
      .parse(fields);
    const result = await parseWorkbook(bytes);
    if (!result.state || metadata.mode === 'flexible') {
      let inspection;
      try {
        inspection = await inspectWorkbook(
          bytes,
          (await r.overview()).state.accounts,
        );
      } catch (e) {
        const errors = [
          {
            sheet: 'Workbook',
            row: 0,
            field: 'file',
            message:
              e instanceof Error ? e.message : 'Cannot inspect workbook.',
          },
        ];
        return envelope(
          await r.importWorkbook({
            ...result,
            state: null,
            errors,
            bytes,
            effectiveAt: metadata.effectiveAt,
            expectedRevision: metadata.expectedRevision,
            templateVersion: 1,
          }),
        );
      }
      const stored = await r.importWorkbook({
        ...result,
        state: null,
        errors: [],
        bytes,
        effectiveAt: metadata.effectiveAt,
        expectedRevision: metadata.expectedRevision,
        templateVersion: 1,
      });
      const latest = await r.getImport(stored.id);
      if (latest.mapping) inspection.mapping = latest.mapping;
      return envelope({ ...latest, inspection });
    }
    return envelope(
      await r.importWorkbook({
        ...result,
        bytes,
        effectiveAt: metadata.effectiveAt,
        expectedRevision: metadata.expectedRevision,
        templateVersion: 1,
      }),
    );
  });
  app.get('/api/v1/portfolio/imports/:id/preview', async (req) =>
    envelope(await r.getImport(id(req.params))),
  );
  app.post('/api/v1/portfolio/imports/:id/parse', async (req) =>
    envelope(
      await workbookAi.parse(
        id(req.params),
        parseWorkbookRequest.parse(req.body),
      ),
    ),
  );
  app.get('/api/v1/portfolio/imports/:id/inspection', async (req) => {
    const source = await r.importSource(id(req.params)),
      latest = await r.getImport(id(req.params));
    const inspection = await inspectWorkbook(
      source.bytes,
      (await r.overview()).state.accounts,
    );
    if (latest.mapping) inspection.mapping = latest.mapping;
    return envelope({ ...latest, inspection });
  });
  app.post('/api/v1/portfolio/imports/:id/mapping', async (req) => {
    const body = z
      .object({
        version: z.literal(1),
        expectedRevision: z.number().int().nonnegative(),
        reviewed: z.literal(true),
        mapping: workbookMappingSchema,
      })
      .strict()
      .parse(req.body);
    const source = await r.importSource(id(req.params));
    const result = await resolveWorkbook(
      source.bytes,
      body.mapping,
      (await r.overview()).state.accounts,
    );
    return envelope(
      await r.mapImport(id(req.params), {
        ...result,
        expectedRevision: body.expectedRevision,
        mapping: body.mapping,
      }),
    );
  });
  app.post('/api/v1/portfolio/imports/:id/confirm', async (req) => {
    const imported = await r.getImport(id(req.params));
    if (!imported.preview)
      throw new PortfolioError(
        'INVALID_WORKBOOK',
        'Resolve workbook errors before confirmation.',
      );
    const result = await r.confirm(
      imported.preview.id,
      confirmSchema.parse(req.body),
    );
    return envelope(result, result.revision);
  });
  app.post('/api/v1/portfolio/baselines/:id/restore-preview', async (req) => {
    const body = z
      .object({
        version: z.literal(1),
        expectedRevision: z.number().int().nonnegative(),
        idempotencyKey: z.string().min(1).max(100),
        effectiveAt: timestamp,
      })
      .strict()
      .parse(req.body);
    return envelope(await r.restore(id(req.params), body));
  });
}
