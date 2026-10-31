import {
  check,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  numeric,
  jsonb,
  date,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  State,
  Operation,
  Change,
  Realized,
  Instrument,
  WorkbookMapping,
  ImportSource,
} from '@m2d/portfolio';

const money = (name: string) => numeric(name, { precision: 30, scale: 12 });
const utc = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });
export const portfolioRevision = pgTable(
  'portfolio_revision',
  {
    id: integer('id').primaryKey(),
    revision: integer('revision').notNull().default(0),
    effectiveAt: utc('effective_at'),
    baselineId: uuid('baseline_id'),
  },
  (t) => [
    check('portfolio_singleton', sql`${t.id}=1`),
    check('revision_nonnegative', sql`${t.revision}>=0`),
  ],
);
export const accounts = pgTable(
  'accounts',
  {
    accountKey: text('account_key').primaryKey(),
    displayName: text('display_name').notNull(),
    institution: text('institution').notNull(),
    accountType: text('account_type').notNull(),
    baseCurrency: text('base_currency').notNull(),
    active: boolean('active').notNull(),
    notes: text('notes').notNull(),
  },
  (t) => [
    check('account_currency', sql`${t.baseCurrency} ~ '^[A-Z]{3}$'`),
    check(
      'account_type',
      sql`${t.accountType} in ('CASH','MARGIN','RRSP','TFSA','OTHER')`,
    ),
  ],
);
export const instruments = pgTable(
  'instruments',
  {
    id: text('id').primaryKey(),
    definition: jsonb('definition').$type<Instrument>().notNull(),
    assetType: text('asset_type').notNull(),
    symbol: text('symbol').notNull(),
    exchange: text('exchange').notNull(),
    currency: text('currency').notNull(),
    multiplier: money('multiplier').notNull(),
  },
  (t) => [
    check('instrument_currency', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('instrument_type', sql`${t.assetType} in ('STOCK','ETF','OPTION')`),
    check(
      'instrument_multiplier',
      sql`(${t.assetType}='OPTION' and ${t.multiplier}=100) or (${t.assetType}<>'OPTION' and ${t.multiplier}=1)`,
    ),
  ],
);
export const positionProjection = pgTable(
  'position_projection',
  {
    accountKey: text('account_key')
      .notNull()
      .references(() => accounts.accountKey),
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    quantity: money('quantity').notNull(),
    averageCost: money('average_cost'),
    description: text('description'),
    optionGroup: text('option_group'),
    transactionDate: date('transaction_date', { mode: 'string' }),
    quality: text('quality').notNull(),
    notes: text('notes').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountKey, t.instrumentId] }),
    check('position_cost', sql`${t.averageCost}>=0`),
    check(
      'position_unknown_cost',
      sql`${t.averageCost} is not null or ${t.quality}='UNKNOWN'`,
    ),
    check(
      'position_quality',
      sql`${t.quality} in ('BASELINE_ESTIMATE','COMPLETE_LEDGER','UNKNOWN')`,
    ),
  ],
);
export const cashProjection = pgTable(
  'cash_projection',
  {
    accountKey: text('account_key')
      .notNull()
      .references(() => accounts.accountKey),
    currency: text('currency').notNull(),
    balance: money('balance').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountKey, t.currency] }),
    check('cash_currency', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);
export const portfolioImports = pgTable(
  'portfolio_imports',
  {
    id: uuid('id').primaryKey(),
    hash: text('hash').notNull().unique(),
    originalBase64: text('original_base64').notNull(),
    templateVersion: integer('template_version').notNull(),
    effectiveOnConfirmation: boolean('effective_on_confirmation')
      .notNull()
      .default(false),
    effectiveAt: utc('effective_at').notNull(),
    createdAt: utc('created_at').notNull(),
    errors: jsonb('errors').$type<unknown[]>().notNull(),
    normalized: jsonb('normalized').$type<State | null>(),
  },
  (t) => [check('import_version', sql`${t.templateVersion}=1`)],
);
export const portfolioImportMappings = pgTable('portfolio_import_mappings', {
  id: uuid('id').primaryKey(),
  importId: uuid('import_id')
    .notNull()
    .references(() => portfolioImports.id),
  createdAt: utc('created_at').notNull(),
  config: jsonb('config').$type<WorkbookMapping>().notNull(),
  errors: jsonb('errors').$type<unknown[]>().notNull(),
  sources: jsonb('sources').$type<ImportSource[]>().notNull(),
  warnings: jsonb('warnings').$type<string[]>().notNull(),
  normalized: jsonb('normalized').$type<State | null>(),
  previewId: uuid('preview_id'),
  memory: jsonb('memory').$type<unknown>(),
});
export const portfolioImportMemories = pgTable('portfolio_import_memories', {
  id: uuid('id').primaryKey(),
  signature: text('signature').notNull(),
  createdAt: utc('created_at').notNull(),
  sourceImportId: uuid('source_import_id')
    .notNull()
    .references(() => portfolioImports.id),
  profile: jsonb('profile').$type<unknown>().notNull(),
});
export const portfolioAccountAliases = pgTable('portfolio_account_aliases', {
  sheetName: text('sheet_name').primaryKey(),
  accountKey: text('account_key')
    .notNull()
    .references(() => accounts.accountKey),
  updatedAt: utc('updated_at').notNull(),
  sourceImportId: uuid('source_import_id')
    .notNull()
    .references(() => portfolioImports.id),
});
export const portfolioImportRuns = pgTable(
  'portfolio_import_runs',
  {
    id: uuid('id').primaryKey(),
    importId: uuid('import_id')
      .notNull()
      .references(() => portfolioImports.id),
    requestKey: uuid('request_key').notNull().unique(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: utc('created_at').notNull(),
    finishedAt: utc('finished_at'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull(),
    request: jsonb('request').$type<unknown>().notNull(),
    response: jsonb('response').$type<unknown>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
  },
  (t) => [
    check(
      'import_run_status',
      sql`${t.status} IN ('RUNNING','COMPLETED','FAILED')`,
    ),
  ],
);
export const portfolioPreviews = pgTable(
  'portfolio_previews',
  {
    id: uuid('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    hash: text('hash').notNull(),
    expectedRevision: integer('expected_revision').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    createdAt: utc('created_at').notNull(),
    expiresAt: utc('expires_at').notNull(),
    effectiveAt: utc('effective_at').notNull(),
    importId: uuid('import_id').references(() => portfolioImports.id),
    restoresBaselineId: uuid('restores_baseline_id'),
    operation: jsonb('operation').$type<Operation | null>(),
    proposed: jsonb('proposed').$type<State>().notNull(),
    changes: jsonb('changes').$type<Change[]>().notNull(),
    warnings: jsonb('warnings').$type<string[]>().notNull(),
    realized: jsonb('realized').$type<Realized[]>().notNull(),
    confirmedRevision: integer('confirmed_revision'),
  },
  (t) => [
    check(
      'preview_status',
      sql`${t.status} in ('PENDING','CONFIRMED','EXPIRED','CONFLICT','REJECTED')`,
    ),
    check('preview_kind', sql`${t.kind} in ('EVENT','BASELINE')`),
    check('preview_revision', sql`${t.expectedRevision}>=0`),
    check('preview_expiry', sql`${t.expiresAt}>${t.createdAt}`),
  ],
);
export const portfolioBaselines = pgTable('portfolio_baselines', {
  id: uuid('id').primaryKey(),
  revision: integer('revision').notNull().unique(),
  effectiveAt: utc('effective_at').notNull(),
  availableAt: utc('available_at').notNull(),
  previewId: uuid('preview_id')
    .notNull()
    .unique()
    .references(() => portfolioPreviews.id),
  snapshot: jsonb('snapshot').$type<State>().notNull(),
  importId: uuid('import_id').references(() => portfolioImports.id),
  restoresBaselineId: uuid('restores_baseline_id'),
});
export const portfolioEvents = pgTable('portfolio_events', {
  id: uuid('id').primaryKey(),
  revision: integer('revision').notNull().unique(),
  baselineId: uuid('baseline_id').references(() => portfolioBaselines.id),
  effectiveAt: utc('effective_at').notNull(),
  availableAt: utc('available_at').notNull(),
  previewId: uuid('preview_id')
    .notNull()
    .unique()
    .references(() => portfolioPreviews.id),
  operation: jsonb('operation').$type<Operation>().notNull(),
  realized: jsonb('realized').$type<Realized[]>().notNull(),
});
export const portfolioChangeLog = pgTable('portfolio_change_log', {
  id: uuid('id').primaryKey(),
  revision: integer('revision').notNull().unique(),
  kind: text('kind').notNull(),
  recordId: uuid('record_id').notNull(),
  previewId: uuid('preview_id')
    .notNull()
    .unique()
    .references(() => portfolioPreviews.id),
  effectiveAt: utc('effective_at').notNull(),
  availableAt: utc('available_at').notNull(),
  changes: jsonb('changes').$type<Change[]>().notNull(),
  note: text('note').notNull(),
});

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
