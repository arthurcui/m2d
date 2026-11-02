import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase } from '../packages/db/src/index.js';
import { migrateDatabase } from '../packages/db/src/migrate.js';
import { createRiskService } from '../apps/api/src/risk.js';
import { buildApp } from '../apps/api/src/app.js';
import { readConfig } from '../packages/config/src/index.js';
import {
  sevenAccountFixture,
  workbook,
  parseWorkbook,
} from '../packages/ingestion/src/index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Disposable TEST_DATABASE_URL required');
const name = 'm2d_risk_test_' + randomUUID().replaceAll('-', ''),
  target = new URL(url);
target.pathname = '/' + name;
const admin = createDatabase(url),
  db = createDatabase(target.toString()),
  service = createRiskService(db.portfolio, db.risk);
const app = buildApp(
  db.repository,
  readConfig({ DATABASE_URL: target.toString() }),
  false,
  db.portfolio,
  { risk: service, chat: db.chat },
);
beforeAll(async () => {
  await admin.pool.query(`create database "${name}"`);
  await migrateDatabase(target.toString());
  await migrateDatabase(target.toString());
  const bytes = await workbook(sevenAccountFixture()),
    parsed = await parseWorkbook(bytes);
  const staged = await db.portfolio.importWorkbook({
    ...parsed,
    bytes,
    effectiveAt: '2026-01-01T00:00:00Z',
    expectedRevision: 0,
    templateVersion: 1,
  });
  await db.portfolio.confirm(staged.preview!.id, {
    version: 1,
    confirmed: true,
    expectedRevision: 0,
    fullReplacementAcknowledged: true,
  });
});
afterAll(async () => {
  await app.close();
  await db.close();
  await admin.pool.query(`drop database "${name}"`);
  await admin.close();
});
it('exposes risk and stock-sale analysis without mutations; saves immutable idempotent plans', async () => {
  const before = await db.portfolio.overview();
  const holding = before.state.positions.find(
    (p) => p.instrument.assetType !== 'OPTION' && Number(p.quantity) >= 1,
  )!;
  const risk = await app.inject('/api/v1/risk/summary');
  expect(risk.statusCode).toBe(200);
  expect(risk.json().data.portfolioRevision).toBe(before.revision);
  const stock = await app.inject({
    method: 'POST',
    url: '/api/v1/risk/stock-trade',
    payload: {
      version: 1,
      accountKey: holding.accountKey,
      instrument: holding.instrument,
      action: 'SELL',
      quantity: '1',
      price: '100',
      fees: '0',
      stopPrice: null,
      targetPrice: null,
      riskBudget: null,
    },
  });
  expect(stock.statusCode, stock.body).toBe(200);
  expect(stock.json().data.action).toBe('SELL');
  const input = {
    version: 1,
    idempotencyKey: randomUUID(),
    portfolioRevision: before.revision,
    analysis: {
      version: 1,
      strategy: 'STOCK',
      accountKey: holding.accountKey,
      legs: [
        { instrument: holding.instrument, quantity: '1', entryPrice: '100' },
      ],
      fees: '0',
      slippage: '0',
      scenarioPrices: [],
    },
    stockAction: 'SELL',
    entryCondition: 'Reduce concentrated exposure',
    invalidation: 'Reassess if thesis improves',
    target: 'Reduce one share',
    mainRisk: 'Price may recover after sale',
    riskBudget: '10000',
    stopPrice: null,
    targetPrice: null,
    portfolioReviewed: true,
  };
  const preview = await app.inject({
    method: 'POST',
    url: '/api/v1/risk/plans/preview',
    payload: input,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.json().data.assessment.stockTrade.action).toBe('SELL');
  expect(await db.risk.list()).toEqual([]);
  const writes = await Promise.all(
    [1, 2].map(() =>
      app.inject({ method: 'POST', url: '/api/v1/risk/plans', payload: input }),
    ),
  );
  expect(writes.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(writes[0]!.json().data.id).toBe(writes[1]!.json().data.id);
  expect(await db.risk.list()).toHaveLength(1);
  const draft = await service.tool(
    'trade_plan_preview_v1',
    (({ idempotencyKey: _key, portfolioRevision: _revision, ...rest }) => {
      void _key;
      void _revision;
      return rest;
    })(input),
  );
  expect(draft).toHaveProperty('assessment.status', 'WATCH_ONLY');
  expect(await db.risk.list()).toHaveLength(1);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/risk/plans',
        payload: { ...input, mainRisk: 'A different risk' },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/risk/plans',
        payload: {
          ...input,
          idempotencyKey: randomUUID(),
          portfolioRevision: 0,
        },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/risk/plans',
        payload: { ...input, idempotencyKey: randomUUID(), mainRisk: '' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/risk/plans',
        headers: { origin: 'https://evil.example' },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  await expect(
    db.pool.query("update trade_plans set status='ACTIONABLE'"),
  ).rejects.toThrow();
  expect(await db.portfolio.overview()).toEqual(before);
});
