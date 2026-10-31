import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase } from '../packages/db/src/index.js';
import { migrateDatabase } from '../packages/db/src/migrate.js';
import {
  sevenAccountFixture,
  parseWorkbook,
  workbook,
} from '../packages/ingestion/src/index.js';
import { operationSchema, diff } from '../packages/portfolio/src/index.js';
import { buildApp } from '../apps/api/src/app.js';
import { readConfig } from '../packages/config/src/index.js';
import { arbitraryWorkbook } from './flexible-fixture.js';
import type { WorkbookInspection } from '../packages/portfolio/src/index.js';
import { createWorkbookAi } from '../apps/api/src/workbook-ai.js';
import {
  prepareWorkbook,
  fixtureForInspection,
  interpretationSchema,
  scopedAnswer,
} from '../packages/agent/src/index.js';
import { FixtureProvider } from '../packages/llm/src/index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable PostgreSQL database with CREATEDB permission. No tests skipped.',
  );
const admin = createDatabase(url),
  name = `m2d_portfolio_test_${randomUUID().replaceAll('-', '')}`;
const testUrl = new URL(url);
testUrl.pathname = `/${name}`;
const database = createDatabase(testUrl.toString()),
  r = database.portfolio;
const app = buildApp(
  database.repository,
  readConfig({ DATABASE_URL: testUrl.toString() }),
  false,
  r,
);
const effectiveAt = '2026-01-01T18:00:00Z';
beforeAll(async () => {
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  await migrateDatabase(testUrl.toString());
  await migrateDatabase(testUrl.toString());
});
afterAll(async () => {
  await app.close();
  await database.close();
  await admin.pool.query(`DROP DATABASE "${name}"`);
  await admin.close();
});
it('stages seven accounts, confirms atomically, preserves immutable history and deduplicates workbook retries', async () => {
  const fixture = sevenAccountFixture(),
    bytes = await workbook(fixture),
    parsed = await parseWorkbook(bytes);
  const staged = await r.importWorkbook({
    ...parsed,
    bytes,
    effectiveAt,
    expectedRevision: 0,
    templateVersion: 1,
  });
  expect(staged.errors).toEqual([]);
  expect((await r.overview()).state.accounts).toHaveLength(0);
  await expect(
    r.confirm(staged.preview!.id, {
      version: 1,
      confirmed: true,
      expectedRevision: 0,
    }),
  ).rejects.toThrow('acknowledge');
  const results = await Promise.all([
    r.confirm(staged.preview!.id, {
      version: 1,
      confirmed: true,
      expectedRevision: 0,
      fullReplacementAcknowledged: true,
    }),
    r.confirm(staged.preview!.id, {
      version: 1,
      confirmed: true,
      expectedRevision: 0,
      fullReplacementAcknowledged: true,
    }),
  ]);
  expect(results.map((x) => x.duplicate).sort()).toEqual([false, true]);
  expect((await r.overview()).state.accounts).toHaveLength(7);
  expect(await r.history()).toHaveLength(1);
  const duplicate = await r.importWorkbook({
    ...parsed,
    bytes,
    effectiveAt,
    expectedRevision: 1,
    templateVersion: 1,
  });
  expect(duplicate.preview?.status).toBe('CONFIRMED');
  expect(duplicate.id).toBe(staged.id);
  fixture.positions.pop();
  fixture.accounts.pop();
  fixture.cash.pop();
  const replacementBytes = await workbook(fixture),
    replacementParsed = await parseWorkbook(replacementBytes);
  const replacement = await r.importWorkbook({
    ...replacementParsed,
    bytes: replacementBytes,
    effectiveAt,
    expectedRevision: 1,
    templateVersion: 1,
  });
  expect(
    (await r.overview()).state.positions.find((p) => p.accountKey === 'DEMO7')
      ?.quantity,
  ).toBe('100');
  expect(
    replacement.preview!.changes.some(
      (c) => c.before.includes('100') && c.after.startsWith('0'),
    ),
  ).toBe(true);
  await r.confirm(replacement.preview!.id, {
    version: 1,
    confirmed: true,
    expectedRevision: 1,
    fullReplacementAcknowledged: true,
  });
  expect(
    (await r.overview()).state.positions.find((p) => p.accountKey === 'DEMO7')
      ?.quantity,
  ).toBe('0');
  expect(await r.history()).toHaveLength(2);
  const original = (await r.history()).find((h) => h.revision === 1)!;
  expect(
    (
      await database.pool.query<{ snapshot: { accounts: unknown[] } }>(
        'SELECT snapshot FROM portfolio_baselines WHERE id=$1',
        [original.recordId],
      )
    ).rows[0]?.snapshot.accounts,
  ).toHaveLength(7);
  await expect(
    database.pool.query('DELETE FROM portfolio_baselines WHERE id=$1', [
      original.recordId,
    ]),
  ).rejects.toThrow('immutable');
  const restore = await r.restore(original.recordId, {
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    effectiveAt,
  });
  await r.confirm(restore.id, {
    version: 1,
    confirmed: true,
    expectedRevision: 2,
    fullReplacementAcknowledged: true,
  });
  expect(
    (await r.overview()).state.positions.find((p) => p.accountKey === 'DEMO7')
      ?.quantity,
  ).toBe('100');
});
it('serializes competing confirmations, expires stale previews, rejects backdating and replays deterministic state', async () => {
  const start = await r.overview();
  const operation = operationSchema.parse({
    kind: 'CASH_DEPOSIT',
    accountKey: 'DEMO1',
    currency: 'USD',
    amount: '12.34',
    effectiveAt: '2026-01-02T18:00:00Z',
    note: 'Golden deposit',
  });
  const key = randomUUID(),
    a = await r.preview({
      expectedRevision: start.revision,
      idempotencyKey: key,
      operation,
    }),
    b = await r.preview({
      expectedRevision: start.revision,
      idempotencyKey: randomUUID(),
      operation,
    });
  await expect(
    r.preview({
      expectedRevision: start.revision,
      idempotencyKey: key,
      operation: { ...operation, note: 'Different' },
    }),
  ).rejects.toThrow('different content');
  const results = await Promise.allSettled([
    r.confirm(a.id, {
      version: 1,
      confirmed: true,
      expectedRevision: start.revision,
    }),
    r.confirm(b.id, {
      version: 1,
      confirmed: true,
      expectedRevision: start.revision,
    }),
  ]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
  const v = await r.overview();
  expect(v.revision).toBe(start.revision + 1);
  expect(v.state.cash.find((c) => c.accountKey === 'DEMO1')?.balance).toBe(
    '10012.34',
  );
  const expired = await r.preview({
    expectedRevision: v.revision,
    idempotencyKey: randomUUID(),
    operation,
  });
  await database.pool.query(
    "UPDATE portfolio_previews SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1",
    [expired.id],
  );
  await expect(
    r.confirm(expired.id, {
      version: 1,
      confirmed: true,
      expectedRevision: v.revision,
    }),
  ).rejects.toThrow('expired');
  expect((await r.getPreview(expired.id)).status).toBe('EXPIRED');
  await expect(
    r.preview({
      expectedRevision: v.revision,
      idempotencyKey: randomUUID(),
      operation: { ...operation, effectiveAt: '2025-12-31T18:00:00Z' },
    }),
  ).rejects.toThrow('boundary');
  await expect(
    r.preview({
      expectedRevision: v.revision,
      idempotencyKey: randomUUID(),
      operation: { ...operation, effectiveAt: '2099-12-31T18:00:00Z' },
    }),
  ).rejects.toThrow('future');
  expect(diff(await r.replay(), v.state)).toEqual([]);
  const reconnect = createDatabase(testUrl.toString());
  expect(diff((await reconnect.portfolio.overview()).state, v.state)).toEqual(
    [],
  );
  await reconnect.close();
  const note = await r.preview({
    expectedRevision: v.revision,
    idempotencyKey: randomUUID(),
    operation: operationSchema.parse({
      kind: 'NOTE_ONLY',
      accountKey: 'DEMO1',
      effectiveAt: '2026-01-02T18:00:00Z',
      note: 'Supporting evidence recorded separately',
    }),
  });
  await r.confirm(note.id, {
    version: 1,
    confirmed: true,
    expectedRevision: v.revision,
  });
  expect((await r.history('DEMO1'))[0]?.note).toBe(
    'Supporting evidence recorded separately',
  );
  expect(diff((await r.overview()).state, v.state)).toEqual([]);
});
it('rolls back financial state on ledger failure and stores invalid uploads without portfolio writes', async () => {
  const start = await r.overview(),
    operation = operationSchema.parse({
      kind: 'CASH_DEPOSIT',
      accountKey: 'DEMO1',
      currency: 'USD',
      amount: '1',
      effectiveAt: '2026-01-03T18:00:00Z',
      note: 'Rollback probe',
    });
  const p = await r.preview({
    expectedRevision: start.revision,
    idempotencyKey: randomUUID(),
    operation,
  });
  await database.pool.query(
    "CREATE FUNCTION reject_test_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$",
  );
  await database.pool.query(
    'CREATE TRIGGER reject_test_log BEFORE INSERT ON portfolio_change_log FOR EACH ROW EXECUTE FUNCTION reject_test_log()',
  );
  try {
    await expect(
      r.confirm(p.id, {
        version: 1,
        confirmed: true,
        expectedRevision: start.revision,
      }),
    ).rejects.toMatchObject({ cause: { message: 'injected failure' } });
  } finally {
    await database.pool.query(
      'DROP TRIGGER reject_test_log ON portfolio_change_log',
    );
  }
  expect(await r.overview()).toEqual(start);
  expect((await r.getPreview(p.id)).status).toBe('PENDING');
  const bytes = Buffer.from('invalid workbook'),
    parsed = await parseWorkbook(bytes);
  const imported = await r.importWorkbook({
    ...parsed,
    bytes,
    effectiveAt,
    expectedRevision: start.revision,
    templateVersion: 1,
  });
  expect(imported.errors.length).toBeGreaterThan(0);
  expect(imported.preview).toBeNull();
  expect(await r.overview()).toEqual(start);
});
it('enforces versioned HTTP schemas, no-confirm safety, multipart imports and browser origin boundaries', async () => {
  const start = await r.overview();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/portfolio/changes/preview',
    payload: {
      version: 1,
      expectedRevision: start.revision,
      idempotencyKey: randomUUID(),
      operation: {
        kind: 'CASH_DEPOSIT',
        accountKey: 'DEMO1',
        currency: 'USD',
        amount: '5',
        effectiveAt: '2026-01-03T18:00:00Z',
        note: 'API preview',
      },
    },
  });
  expect(response.statusCode).toBe(200);
  const p = response.json().data as { id: string };
  expect(await r.overview()).toEqual(start);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/portfolio/changes/${p.id}/confirm`,
        payload: {
          version: 1,
          expectedRevision: start.revision,
          confirmed: false,
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/portfolio/changes/preview',
        headers: { origin: 'https://attacker.invalid' },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/portfolio/changes/preview',
        payload: { version: 2 },
      })
    ).statusCode,
  ).toBe(400);
  // Use distinct content and a current effective date: XLSX ZIP timestamps must
  // not decide whether this request is a duplicate of the earlier baseline.
  const httpFixture = sevenAccountFixture();
  httpFixture.accounts[0]!.displayName += ' HTTP upload';
  const bytes = await workbook(httpFixture),
    boundary = 'm2d-test-boundary';
  const parts = [
    ...Object.entries({
      templateVersion: '1',
      effectiveAt: '2026-01-04T18:00:00Z',
      expectedRevision: String(start.revision),
    }).map(([key, value]) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="portfolio.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/v1/portfolio/imports',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  expect(uploaded.json().data.errors).toEqual([]);
  expect(
    (await app.inject('/api/v1/portfolio/template')).headers['content-type'],
  ).toContain('spreadsheetml');
});
it('persists reviewed arbitrary-tab mappings, invalidates superseded previews, and confirms the original file only once', async () => {
  const start = await r.overview(),
    bytes = await arbitraryWorkbook(),
    boundary = 'flexible-boundary';
  const metadata = {
    templateVersion: '1',
    effectiveAt: '2026-01-04T18:00:00Z',
    expectedRevision: String(start.revision),
  };
  const payload = Buffer.concat([
    ...Object.entries(metadata).map(([k, v]) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="custom.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/v1/portfolio/imports',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(uploaded.statusCode).toBe(200);
  const data = uploaded.json().data as {
    id: string;
    inspection: WorkbookInspection;
    preview: null;
  };
  expect(data.inspection.sheets).toHaveLength(2);
  expect(data.preview).toBeNull();
  expect(await r.overview()).toEqual(start);
  const body = {
    version: 1,
    expectedRevision: start.revision,
    reviewed: true,
    mapping: data.inspection.mapping,
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/portfolio/imports/${data.id}/mapping`,
        payload: { ...body, reviewed: false },
      })
    ).statusCode,
  ).toBe(400);
  const mapped = await app.inject({
    method: 'POST',
    url: `/api/v1/portfolio/imports/${data.id}/mapping`,
    payload: body,
  });
  expect(mapped.statusCode).toBe(200);
  expect(mapped.json().data.errors).toEqual([]);
  const oldId = String(mapped.json().data.preview.id);
  expect(await r.overview()).toEqual(start);
  const invalid = structuredClone(body);
  invalid.mapping.overrides.push({
    sheet: 'Retirement',
    row: 3,
    values: { Quantity: 'NaN' },
    reason: 'Invalid test',
  });
  const rejected = await app.inject({
    method: 'POST',
    url: `/api/v1/portfolio/imports/${data.id}/mapping`,
    payload: invalid,
  });
  expect(rejected.json().data.preview).toBeNull();
  expect(rejected.json().data.errors.length).toBeGreaterThan(0);
  await expect(
    r.confirm(oldId, {
      version: 1,
      confirmed: true,
      expectedRevision: start.revision,
      fullReplacementAcknowledged: true,
    }),
  ).rejects.toThrow('rejected');
  const fresh = await app.inject({
    method: 'POST',
    url: `/api/v1/portfolio/imports/${data.id}/mapping`,
    payload: body,
  });
  expect(fresh.json().data.errors).toEqual([]);
  const previewId = String(fresh.json().data.preview.id);
  expect(previewId).not.toBe(oldId);
  await r.confirm(previewId, {
    version: 1,
    confirmed: true,
    expectedRevision: start.revision,
    fullReplacementAcknowledged: true,
  });
  const confirmed = await r.overview();
  expect(
    confirmed.state.cash.find((c) => c.accountKey === 'Retirement')?.balance,
  ).toBe('12345.67');
  const repeat = await app.inject({
    method: 'POST',
    url: `/api/v1/portfolio/imports/${data.id}/mapping`,
    payload: body,
  });
  expect(repeat.json().data.preview.status).toBe('CONFIRMED');
  expect((await r.overview()).revision).toBe(confirmed.revision);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/portfolio/imports/${data.id}/mapping`,
        payload: invalid,
      })
    ).statusCode,
  ).toBe(409);
  const saved = await r.getImport(data.id);
  expect(saved.mapping).toEqual(body.mapping);
  expect(saved.sources[0]).toMatchObject({ sheet: 'Retirement', row: 3 });
  expect((await r.importSource(data.id)).bytes).toEqual(bytes);
  await expect(
    database.pool.query(
      'DELETE FROM portfolio_import_mappings WHERE import_id=$1',
      [data.id],
    ),
  ).rejects.toThrow('immutable');
  expect(diff(await r.replay(), confirmed.state)).toEqual([]);
});

it('timestamps immediate imports at confirmation and deduplicates uploads without a client timestamp', async () => {
  const fixture = sevenAccountFixture();
  fixture.accounts[0]!.displayName += ' Immediate import';
  const bytes = await workbook(fixture),
    parsed = await parseWorkbook(bytes),
    before = await r.overview();
  const input = {
    ...parsed,
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1 as const,
  };
  const staged = await r.importWorkbook(input);
  expect((await r.importWorkbook(input)).preview!.id).toBe(staged.preview!.id);
  expect(await r.overview()).toEqual(before);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const confirmedAfter = Date.now();
  const confirmation = {
    version: 1 as const,
    expectedRevision: before.revision,
    confirmed: true as const,
    fullReplacementAcknowledged: true,
  };
  await r.confirm(staged.preview!.id, confirmation);
  const committed = await r.overview();
  expect(Date.parse(committed.effectiveAt!)).toBeGreaterThanOrEqual(
    confirmedAfter,
  );
  expect(Date.parse(committed.effectiveAt!)).toBeLessThanOrEqual(Date.now());
  expect(Date.parse(committed.effectiveAt!)).toBeGreaterThan(
    Date.parse(staged.preview!.effectiveAt),
  );
  expect(
    (await r.importWorkbook({ ...input, expectedRevision: committed.revision }))
      .preview!.id,
  ).toBe(staged.preview!.id);
  expect((await r.confirm(staged.preview!.id, confirmation)).duplicate).toBe(
    true,
  );
  expect(await r.overview()).toEqual(committed);
  const baseline = await database.pool.query(
    'SELECT effective_at FROM portfolio_baselines WHERE id=$1',
    [committed.baselineId],
  );
  expect(baseline.rows[0].effective_at.getTime()).toBe(
    Date.parse(committed.effectiveAt!),
  );
  expect(Date.parse((await r.getPreview(staged.preview!.id)).effectiveAt)).toBe(
    Date.parse(committed.effectiveAt!),
  );
});

it('audits automatic workbook parsing, deduplicates paid dispatch, and keeps failures away from the ledger', async () => {
  const { createWorkbookAi } = await import('../apps/api/src/workbook-ai.js');
  const { prepareWorkbook, fixtureForInspection } =
    await import('../packages/agent/src/index.js');
  const fixture = sevenAccountFixture();
  fixture.accounts[0]!.displayName += ' AI parsing';
  const bytes = await workbook(fixture),
    parsed = await parseWorkbook(bytes),
    before = await r.overview();
  const upload = await r.importWorkbook({
    ...parsed,
    state: null,
    errors: [],
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1,
  });
  const prepared = await prepareWorkbook(
    bytes,
    before.state.accounts,
    '',
    'fixture-v1',
  );
  const provider = fixtureForInspection(
    prepared.inspection,
    before.state.accounts,
  );
  let calls = 0;
  const original = provider.generate.bind(provider);
  provider.generate = async () => {
    calls++;
    return original();
  };
  const service = createWorkbookAi(
    r,
    readConfig({ DATABASE_URL: testUrl.toString() }),
    undefined,
    provider,
  );
  const input = {
    version: 1 as const,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    clarification: '',
    retry: false,
  };
  const first = await service.parse(upload.id, input);
  expect(first.preview).not.toBeNull();
  expect(calls).toBe(1);
  expect(await r.overview()).toEqual(before);
  expect((await service.parse(upload.id, input)).preview!.id).toBe(
    first.preview!.id,
  );
  expect(
    (await service.parse(upload.id, { ...input, idempotencyKey: randomUUID() }))
      .preview!.id,
  ).toBe(first.preview!.id);
  expect(calls).toBe(1);
  await expect(
    service.parse(upload.id, { ...input, clarification: 'Different context' }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const rows = await database.pool.query(
    'SELECT * FROM portfolio_import_runs WHERE import_id=$1',
    [upload.id],
  );
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].status).toBe('COMPLETED');
  expect(rows.rows[0].request.policy).toBe('workbook-v1');
  await expect(
    database.pool.query(
      'UPDATE portfolio_import_runs SET response=$1 WHERE id=$2',
      [{}, rows.rows[0].id],
    ),
  ).rejects.toThrow('immutable');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const concurrent = r.runImportParse(
    {
      importId: upload.id,
      requestKey: randomUUID(),
      provider: 'fixture',
      model: 'fixture-v1',
      request: {},
      fingerprintData: 'concurrency',
      retry: false,
    },
    async () => {
      await gate;
      return {};
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect(
    r.runImportParse(
      {
        importId: upload.id,
        requestKey: randomUUID(),
        provider: 'fixture',
        model: 'fixture-v1',
        request: {},
        fingerprintData: 'other',
        retry: false,
      },
      async () => ({}),
    ),
  ).rejects.toMatchObject({ code: 'AI_BUSY' });
  release();
  await concurrent;
  let failures = 0;
  const failedInput = {
    importId: upload.id,
    requestKey: randomUUID(),
    provider: 'fixture',
    model: 'fixture-v1',
    request: {},
    fingerprintData: 'failure',
    retry: false,
  };
  const failed = async () => {
    failures++;
    throw new Error('secret internal diagnostic');
  };
  expect(
    (await r.runImportParse(failedInput, failed)).errorMessage,
  ).not.toContain('secret');
  await r.runImportParse(failedInput, failed);
  expect(failures).toBe(1);
  await r.runImportParse(
    { ...failedInput, requestKey: randomUUID(), retry: true },
    failed,
  );
  expect(failures).toBe(2);
  expect(await r.overview()).toEqual(before);
  await r.reject(first.preview!.id);
});
it('learns format only on confirmation and reuses it with new values without another model call', async () => {
  const before = await r.overview(),
    bytes = await arbitraryWorkbook('101');
  const parsed = await parseWorkbook(bytes);
  const upload = await r.importWorkbook({
    ...parsed,
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1,
  });
  const prepared = await prepareWorkbook(
    bytes,
    before.state.accounts,
    '',
    'fixture-v1',
  );
  const provider = fixtureForInspection(
    prepared.inspection,
    before.state.accounts,
  );
  let calls = 0;
  const generate = provider.generate.bind(provider);
  provider.generate = async () => {
    calls++;
    return generate();
  };
  const service = createWorkbookAi(
    r,
    readConfig({ DATABASE_URL: testUrl.toString() }),
    undefined,
    provider,
  );
  const input = {
    version: 1 as const,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    clarification: '',
    retry: false,
  };
  const count = (await r.importMemories()).length;
  const first = await service.parse(upload.id, input);
  expect(first.preview, JSON.stringify(first.ai)).not.toBeNull();
  expect(calls).toBe(1);
  expect((await r.importMemories()).length).toBe(count);
  await r.confirm(first.preview!.id, {
    version: 1,
    confirmed: true,
    expectedRevision: before.revision,
    fullReplacementAcknowledged: true,
  });
  expect((await r.importMemories()).length).toBe(count + 1);
  const nextBytes = await arbitraryWorkbook('202', '654.32');
  const next = await r.importWorkbook({
    ...(await parseWorkbook(nextBytes)),
    bytes: nextBytes,
    expectedRevision: before.revision + 1,
    templateVersion: 1,
  });
  const second = await service.parse(next.id, {
    ...input,
    expectedRevision: before.revision + 1,
    idempotencyKey: randomUUID(),
  });
  expect(second.ai?.provider).toBe('remembered');
  expect(calls).toBe(1);
  expect(second.preview?.proposed.positions[0]?.quantity).toBe('202');
  expect(second.preview?.proposed.cash[0]?.balance).toBe('654.32');
  expect(
    (await r.overview()).state.positions.find(
      (p) => p.accountKey === 'Retirement',
    )?.quantity,
  ).toBe('101');
  await r.reject(second.preview!.id);
});
it('asks before treating a new tab as an account and persists confirmed rename aliases without changing identity', async () => {
  const before = await r.overview(),
    bytes = await arbitraryWorkbook(
      '303',
      '1700',
      'Rebranded Retirement',
      '2026-10-30',
    );
  const upload = await r.importWorkbook({
    ...(await parseWorkbook(bytes)),
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1,
  });
  const service = createWorkbookAi(
    r,
    readConfig({ DATABASE_URL: testUrl.toString() }),
    undefined,
  );
  const request = {
    version: 1 as const,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
  };
  const question = await service.parse(upload.id, request);
  expect(question).toMatchObject({
    preview: null,
    ai: {
      provider: 'account-review',
      accountQuestions: [{ sheet: 'Rebranded Retirement' }],
    },
  });
  expect(await r.overview()).toEqual(before);
  expect(
    (
      await database.pool.query(
        'SELECT id FROM portfolio_import_runs WHERE import_id=$1',
        [upload.id],
      )
    ).rows,
  ).toHaveLength(0);
  const decided = await service.parse(upload.id, {
    ...request,
    idempotencyKey: randomUUID(),
    accountDecisions: [
      {
        sheet: 'Rebranded Retirement',
        kind: 'rename',
        accountKey: 'Retirement',
      },
    ],
  });
  expect(decided.preview, JSON.stringify(decided.ai)).not.toBeNull();
  expect(
    decided.preview?.proposed.accounts.find(
      (a) => a.accountKey === 'Retirement',
    )?.displayName,
  ).toBe('Rebranded Retirement');
  expect(
    (await r.accountAliases()).find(
      (a) => a.sheetName === 'rebranded retirement',
    ),
  ).toBeUndefined();
  await r.confirm(decided.preview!.id, {
    version: 1,
    expectedRevision: before.revision,
    confirmed: true,
    fullReplacementAcknowledged: true,
  });
  expect(
    (await r.accountAliases()).find(
      (a) => a.sheetName === 'rebranded retirement',
    )?.accountKey,
  ).toBe('Retirement');
  const after = await r.overview();
  expect(
    after.state.positions.find((p) => p.accountKey === 'Retirement')
      ?.transactionDate,
  ).toBe('2026-10-30');
  expect(
    after.state.accounts.find((a) => a.accountKey === 'Retirement')
      ?.displayName,
  ).toBe('Rebranded Retirement');
  const more = await arbitraryWorkbook(
    '304',
    '1750',
    'Rebranded Retirement',
    '2026-10-31',
  );
  const next = await r.importWorkbook({
    ...(await parseWorkbook(more)),
    bytes: more,
    expectedRevision: after.revision,
    templateVersion: 1,
  });
  const recalled = await service.parse(next.id, {
    version: 1,
    expectedRevision: after.revision,
    idempotencyKey: randomUUID(),
  });
  expect(recalled.preview, JSON.stringify(recalled.ai)).not.toBeNull();
  expect(recalled.ai?.provider).toBe('remembered');
  expect(
    recalled.preview?.proposed.positions.find(
      (p) => p.accountKey === 'Retirement',
    )?.transactionDate,
  ).toBe('2026-10-31');
  await r.reject(recalled.preview!.id);
});
it('keeps explanations on the pending question without changing staging, facts, memory or portfolio', async () => {
  const before = await r.overview();
  const bytes = await arbitraryWorkbook('509');
  const upload = await r.importWorkbook({
    ...(await parseWorkbook(bytes)),
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1,
  });
  const prepared = await prepareWorkbook(
    bytes,
    before.state.accounts,
    '',
    'fixture-v1',
  );
  const output = interpretationSchema.parse(
    (
      await fixtureForInspection(
        prepared.inspection,
        before.state.accounts,
      ).generate()
    ).structuredOutput,
  );
  const provider = new FixtureProvider(output);
  let calls = 0;
  const original = provider.generate.bind(provider);
  provider.generate = async () => {
    calls++;
    return original();
  };
  const service = createWorkbookAi(
    r,
    readConfig({ DATABASE_URL: testUrl.toString() }),
    undefined,
    provider,
  );
  const staged = await r.getImport(upload.id);
  const memory = await r.importMemories();
  const input = {
    version: 1 as const,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    clarification: 'all USD',
    dialogue: {
      message: 'whats AccountType for?',
      question: 'Tab "Retirement": what is the account type?',
      history: [],
    },
  };
  const result = await service.parse(upload.id, input);
  expect(result).toMatchObject({
    preview: null,
    acceptedClarification: 'all USD',
    ai: {
      intent: 'explain',
      questions: [input.dialogue.question],
      reply: expect.stringContaining('not its holdings'),
    },
  });
  // Even a model returning a complete valid mapping cannot turn a question into a preview.
  expect(await r.getImport(upload.id)).toEqual(staged);
  expect(await r.overview()).toEqual(before);
  expect(await r.importMemories()).toEqual(memory);
  await service.parse(upload.id, input);
  expect(calls).toBe(1);
  // The model can also identify an implicit request for explanation.
  output.intent = 'explain';
  output.reply =
    'Account type labels the account. Please check your account details.';
  const implicit = await service.parse(upload.id, {
    ...input,
    idempotencyKey: randomUUID(),
    dialogue: { ...input.dialogue, message: 'That label is confusing' },
  });
  expect(implicit).toMatchObject({
    preview: null,
    acceptedClarification: 'all USD',
    ai: { reply: output.reply, questions: [input.dialogue.question] },
  });
  expect(await r.getImport(upload.id)).toEqual(staged);
  // A real answer can resume interpretation. Help text is not included in the facts.
  output.intent = 'interpret';
  output.reply = '';
  const answer = await service.parse(upload.id, {
    ...input,
    idempotencyKey: randomUUID(),
    dialogue: { ...input.dialogue, message: 'RRSP' },
  });
  expect(answer).toMatchObject({
    acceptedClarification: expect.stringContaining('"answer":"RRSP"'),
  });
  expect(answer.preview, JSON.stringify(answer.ai)).not.toBeNull();
  expect((await r.overview()).revision).toBe(before.revision);
  await r.reject(answer.preview!.id);
});

it('resolves a question already answered by the workbook without asking again', async () => {
  const before = await r.overview();
  const bytes = await arbitraryWorkbook('611');
  const uploaded = await r.importWorkbook({
    ...(await parseWorkbook(bytes)),
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1,
  });
  const prepared = await prepareWorkbook(
    bytes,
    before.state.accounts,
    '',
    'fixture-v1',
  );
  const output = interpretationSchema.parse(
    (
      await fixtureForInspection(
        prepared.inspection,
        before.state.accounts,
      ).generate()
    ).structuredOutput,
  );
  const question = 'Tab "Retirement", row 4: what is the asset class?';
  output.questions = [question];
  const facts = scopedAnswer(question, 'CASH');
  const service = createWorkbookAi(
    r,
    readConfig({ DATABASE_URL: testUrl.toString() }),
    undefined,
    new FixtureProvider(output),
  );
  const result = await service.parse(uploaded.id, {
    version: 1,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    clarification: facts,
  });
  expect(result).toMatchObject({
    acceptedClarification: facts,
    ai: {
      status: 'completed',
      questions: [],
    },
  });
  expect(await r.overview()).toEqual(before);
  expect(result.preview).not.toBeNull();
  await r.reject(result.preview!.id);
});

it('enforces known account identity even when only the model recognizes the table layout', async () => {
  const before = await r.overview();
  const bytes = await arbitraryWorkbook(
    '401',
    '1900',
    'Rebranded Retirement',
    undefined,
    true,
  );
  const normal = await prepareWorkbook(
    await arbitraryWorkbook('401', '1900', 'Rebranded Retirement'),
    before.state.accounts,
    '',
    'fixture-v1',
  );
  const { FixtureProvider } = await import('../packages/llm/src/index.js');
  const { interpretationSchema } =
    await import('../packages/agent/src/index.js');
  const output = interpretationSchema.parse(
    (
      await fixtureForInspection(
        normal.inspection,
        before.state.accounts,
      ).generate()
    ).structuredOutput,
  );
  for (const binding of output.tables[0]!.defaults) {
    if (binding.field === 'AccountKey' || binding.field === 'DisplayName') {
      binding.value = 'Savings';
      binding.source = 'account';
      binding.sheet = 'Savings';
      binding.row = 0;
      binding.column = 0;
    }
  }
  const upload = await r.importWorkbook({
    ...(await parseWorkbook(bytes)),
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1,
  });
  const service = createWorkbookAi(
    r,
    readConfig({ DATABASE_URL: testUrl.toString() }),
    undefined,
    new FixtureProvider(output),
  );
  const result = await service.parse(upload.id, {
    version: 1,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
  });
  expect(result.preview, JSON.stringify(result.ai)).not.toBeNull();
  expect(
    result.preview?.proposed.positions.find(
      (p) => p.instrument.symbol === 'AAPL',
    )?.accountKey,
  ).toBe('Retirement');
  expect((await r.overview()).revision).toBe(before.revision);
  await r.reject(result.preview!.id);
});

it('saves interpretation rules only on confirmation and reloads them with fresh workbook amounts', async () => {
  const { interpretationWorkbook } =
    await import('./interpretation-fixture.js');
  const { inspectWorkbook, resolveWorkbook } =
    await import('../packages/ingestion/src/index.js');
  const { learnImportMemory, recallImportMemory } =
    await import('../packages/agent/src/index.js');
  const before = await r.overview();
  const bytes = await interpretationWorkbook();
  const inspection = await inspectWorkbook(bytes, before.state.accounts);
  const mapping = inspection.mapping;
  mapping.overrides = [
    {
      sheet: 'Rules RRSP',
      row: 2,
      values: { AssetType: 'STOCK' },
      reason: 'User correction',
    },
    {
      sheet: 'Rules RRSP',
      row: 3,
      values: { Multiplier: '100', Deliverable: 'STANDARD' },
      reason: 'Confirmed option terms',
    },
  ];
  const memory = learnImportMemory(inspection, mapping)!;
  const upload = await r.importWorkbook({
    ...(await parseWorkbook(bytes)),
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1,
  });
  const result = await resolveWorkbook(bytes, mapping, before.state.accounts);
  expect(result.errors).toEqual([]);
  const count = (await r.importMemories()).length;
  const staged = await r.mapImport(upload.id, {
    ...result,
    mapping,
    memory,
    expectedRevision: before.revision,
  });
  expect((await r.importMemories()).length).toBe(count);
  await r.reject(staged.preview!.id);
  expect((await r.importMemories()).length).toBe(count);
  const preview = await r.mapImport(upload.id, {
    ...result,
    mapping,
    memory,
    expectedRevision: before.revision,
  });
  const confirmation = {
    version: 1 as const,
    confirmed: true as const,
    expectedRevision: before.revision,
    fullReplacementAcknowledged: true,
  };
  await r.confirm(preview.preview!.id, confirmation);
  await r.confirm(preview.preview!.id, confirmation);
  const saved = await r.importMemories();
  expect(saved.length).toBe(count + 1);
  expect(saved[0]?.profile).toMatchObject({
    version: 2,
    rules: expect.arrayContaining([
      expect.objectContaining({ field: 'AssetType', value: 'STOCK' }),
    ]),
  });
  expect(saved[0]?.sourceImportId).toBe(upload.id);
  const reopened = createDatabase(testUrl.toString());
  try {
    const nextBytes = await interpretationWorkbook(
      '71',
      '7654.32',
      '28.5',
      true,
    );
    const next = await reopened.portfolio.importWorkbook({
      ...(await parseWorkbook(nextBytes)),
      bytes: nextBytes,
      expectedRevision: before.revision + 1,
      templateVersion: 1,
    });
    const provider = new FixtureProvider({});
    provider.generate = async () => {
      throw new Error(
        'Confirmed rules should avoid inference for this matching workbook',
      );
    };
    const service = createWorkbookAi(
      reopened.portfolio,
      readConfig({ DATABASE_URL: testUrl.toString() }),
      undefined,
      provider,
    );
    const recalled = await service.parse(next.id, {
      version: 1,
      expectedRevision: before.revision + 1,
      idempotencyKey: randomUUID(),
    });
    expect(recalled.ai.provider).toBe('remembered');
    expect(
      recalled.preview?.proposed.positions.find(
        (p) => p.instrument.symbol === 'AAA',
      ),
    ).toMatchObject({ quantity: '71', averageCost: '28.5' });
    expect(recalled.preview?.proposed.cash[0]?.balance).toBe('7654.32');
    expect(recalled.preview?.warnings.join(' ')).toContain('current year');
    expect(
      (await reopened.portfolio.overview()).state.cash.find(
        (c) => c.accountKey === 'Rules_RRSP',
      )?.balance,
    ).toBe('4123.45');
    await reopened.portfolio.reject(recalled.preview!.id);
    expect((await reopened.portfolio.importMemories()).length).toBe(count + 1);
    const nextInspection = await inspectWorkbook(
      nextBytes,
      (await reopened.portfolio.overview()).state.accounts,
    );
    const updatedMapping = recallImportMemory(
      saved[0]!.profile,
      nextInspection,
    )!;
    updatedMapping.overrides.find((o) => o.values.AssetType)!.values.AssetType =
      'ETF';
    const updatedMemory = learnImportMemory(
      nextInspection,
      updatedMapping,
      saved[0]!.profile,
    )!;
    const updatedResult = await resolveWorkbook(
      nextBytes,
      updatedMapping,
      (await reopened.portfolio.overview()).state.accounts,
    );
    const update = await reopened.portfolio.mapImport(next.id, {
      ...updatedResult,
      mapping: updatedMapping,
      memory: updatedMemory,
      expectedRevision: before.revision + 1,
    });
    await reopened.portfolio.confirm(update.preview!.id, {
      ...confirmation,
      expectedRevision: before.revision + 1,
    });
    const versions = await reopened.portfolio.importMemories();
    expect(versions.length).toBe(count + 2);
    expect(versions[0]?.profile).toMatchObject({
      rules: expect.arrayContaining([
        expect.objectContaining({ field: 'AssetType', value: 'ETF' }),
      ]),
    });
    expect(versions.find((v) => v.id === saved[0]!.id)?.profile).toMatchObject({
      rules: expect.arrayContaining([
        expect.objectContaining({ field: 'AssetType', value: 'STOCK' }),
      ]),
    });
  } finally {
    await reopened.close();
  }
});

it('recovers legacy internal questions and identifies real rows without model calls or portfolio writes', async () => {
  const before = await r.overview();
  const bytes = await arbitraryWorkbook('19', '500', 'Guidance RRSP');
  const upload = await r.importWorkbook({
    ...(await parseWorkbook(bytes)),
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1,
  });
  const provider = new FixtureProvider({});
  provider.generate = async () => {
    throw new Error(
      'No model should be called for source navigation or internal-field recovery',
    );
  };
  const service = createWorkbookAi(
    r,
    readConfig({ DATABASE_URL: testUrl.toString() }),
    undefined,
    provider,
  );
  const recovered = await service.parse(upload.id, {
    version: 1,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    clarification: 'all USD',
    dialogue: {
      question: 'Tab "Guidance RRSP": I could not validate account key.',
      message: 'which row?',
    },
  });
  expect(recovered.ai.status).toBe('needs_review');
  expect(recovered.ai.questions).toEqual([]);
  expect(recovered.acceptedClarification).toBe('all USD');
  expect(recovered.ai.reply).toContain('application error');
  const located = await service.parse(upload.id, {
    version: 1,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    dialogue: {
      question: 'Tab "Guidance RRSP", row 3: what is the quantity?',
      message: 'which row are you talking about?',
    },
  });
  expect(located.ai.reply).toContain('row 3:');
  expect(located.ai.reply).toContain('column ');
  expect(located.preview).toBeNull();
  const duplicate = await service.parse(upload.id, {
    version: 1,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    dialogue: {
      question: 'AI assigned a field more than once.',
      message: 'can we move on?',
    },
  });
  expect(duplicate.ai.status).toBe('needs_review');
  expect(duplicate.ai.questions).toEqual([]);
  expect(duplicate.ai.reply).toContain('blocked until it passes validation');
  const prepared = await prepareWorkbook(
    bytes,
    before.state.accounts,
    '',
    'fixture-v1',
  );
  const response = await fixtureForInspection(
    prepared.inspection,
    before.state.accounts,
  ).generate();
  provider.generate = async () => response;
  const retried = await service.parse(upload.id, {
    version: 1,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    retry: true,
    accountDecisions: [{ sheet: 'Guidance RRSP', kind: 'new' }],
    dialogue: {
      question: 'Tab "Guidance RRSP": I could not validate account key.',
      message: 'Please explain this question.',
      explain: true,
    },
  });
  expect(retried.preview, JSON.stringify(retried.ai)).not.toBeNull();
  await r.reject(retried.preview!.id);
  expect((await r.overview()).revision).toBe(before.revision);
});

it('retains all seven account choices when a model omits reviewed tabs', async () => {
  const { sevenAccountTabs } = await import('./flexible-fixture.js');
  const bytes = await sevenAccountTabs();
  const before = await r.overview();
  const prepared = await prepareWorkbook(
    bytes,
    before.state.accounts,
    '',
    'fixture-v1',
  );
  const output = interpretationSchema.parse(
    (
      await fixtureForInspection(
        prepared.inspection,
        before.state.accounts,
      ).generate()
    ).structuredOutput,
  );
  output.tables = output.tables.slice(0, 3);
  for (const sheet of prepared.inspection.sheets.slice(3))
    output.excludedRows.push({
      sheet: sheet.name,
      row: 2,
      reason: 'Data row excluded by model for review',
    });
  const provider = new FixtureProvider(output);
  const originalGenerate = provider.generate.bind(provider);
  let calls = 0;
  provider.generate = async () => {
    calls++;
    return originalGenerate();
  };
  const service = createWorkbookAi(
    r,
    readConfig({ DATABASE_URL: testUrl.toString() }),
    undefined,
    provider,
  );
  const upload = await r.importWorkbook({
    ...(await parseWorkbook(bytes)),
    bytes,
    expectedRevision: before.revision,
    templateVersion: 1,
  });
  const decisions: { sheet: string; kind: 'new' }[] = [];
  for (const sheet of prepared.inspection.sheets) {
    const result = await service.parse(upload.id, {
      version: 1,
      expectedRevision: before.revision,
      idempotencyKey: randomUUID(),
      accountDecisions: [...decisions],
    });
    expect(result.ai.accountQuestions).toHaveLength(7 - decisions.length);
    decisions.push({ sheet: sheet.name, kind: 'new' });
  }
  const request = {
    version: 1 as const,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    accountDecisions: decisions,
  };
  const result = await service.parse(upload.id, request);
  expect(result.ai.status).toBe('needs_review');
  expect(result.ai.reply).toContain('unmapped');
  expect(result.ai.accountQuestions).toBeUndefined();
  expect(result.preview).toBeNull();
  await service.parse(upload.id, request);
  expect(calls).toBe(1);
  await expect(
    service.parse(upload.id, {
      ...request,
      idempotencyKey: randomUUID(),
      accountDecisions: [...decisions, decisions[0]!],
    }),
  ).rejects.toThrow('Choose once');
  expect((await r.overview()).revision).toBe(before.revision);
});
