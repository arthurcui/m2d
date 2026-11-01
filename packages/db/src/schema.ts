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
  index,
  uniqueIndex,
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
import type { Payload, Valuation } from '@m2d/market';

export const marketObservations = pgTable(
  'market_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    contentHash: text('content_hash').notNull().unique(),
    asOf: timestamp('as_of', { withTimezone: true, mode: 'string' }).notNull(),
    receivedAt: timestamp('received_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    availableAt: timestamp('available_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    payload: jsonb('payload').$type<Payload>().notNull(),
    raw: jsonb('raw').$type<unknown>().notNull(),
  },
  (t) => [
    check(
      'market_provider',
      sql`${t.provider} in ('fixture','twelvedata','massive','ibkr')`,
    ),
    check(
      'market_kind',
      sql`${t.kind} in ('quote','bars','fx','options','listing')`,
    ),
    check(
      'market_observation_time',
      sql`${t.asOf} <= ${t.receivedAt} and ${t.receivedAt} <= ${t.availableAt}`,
    ),
    index('market_lookup').on(t.provider, t.kind, t.subject, t.asOf),
  ],
);
export const marketRefreshes = pgTable(
  'market_refreshes',
  {
    requestKey: text('request_key').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    observationId: uuid('observation_id').references(
      () => marketObservations.id,
    ),
  },
  (t) => [
    check(
      'market_refresh_status',
      sql`${t.status} in ('PENDING','SUCCEEDED','FAILED')`,
    ),
  ],
);
export const valuationSnapshots = pgTable(
  'valuation_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestKey: text('request_key').notNull().unique(),
    portfolioRevision: integer('portfolio_revision').notNull(),
    computedAt: timestamp('computed_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    provider: text('provider').notNull(),
    baseCurrency: text('base_currency').notNull(),
    valuation: jsonb('valuation').$type<Valuation>().notNull(),
    observationIds: jsonb('observation_ids').$type<string[]>().notNull(),
  },
  (t) => [
    check('valuation_revision', sql`${t.portfolioRevision}>=0`),
    check('valuation_currency', sql`${t.baseCurrency} ~ '^[A-Z]{3}$'`),
  ],
);

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

export const appSettings = pgTable(
  'app_settings',
  {
    id: integer('id').primaryKey().default(1),
    revision: integer('revision').notNull().default(0),
    defaultAnalysisMode: text('default_analysis_mode'),
    marketProvider: text('market_provider'),
    listingProvider: text('listing_provider'),
    priceRefreshSeconds: integer('price_refresh_seconds').notNull().default(0),
  },
  (t) => [
    check('settings_singleton', sql`${t.id} = 1`),
    check(
      'settings_market_provider',
      sql`${t.marketProvider} in ('fixture','massive','ibkr','twelvedata')`,
    ),
    check(
      'settings_listing_provider',
      sql`${t.listingProvider} in ('none','fixture','massive','ibkr')`,
    ),
    check(
      'settings_price_refresh',
      sql`${t.priceRefreshSeconds} = 0 or ${t.priceRefreshSeconds} between 15 and 3600`,
    ),
    check(
      'settings_mode',
      sql`${t.defaultAnalysisMode} in ('quick','standard','extensive')`,
    ),
  ],
);
export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  context: text('context').notNull().unique(),
  history: jsonb('history').notNull().default([]),
  continuation: jsonb('continuation'),
  draft: text('draft').notNull().default(''),
  revision: integer('revision').notNull().default(0),
  createdAt: utc('created_at').notNull().defaultNow(),
  updatedAt: utc('updated_at').notNull().defaultNow(),
});
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id),
    requestKey: uuid('request_key').notNull().unique(),
    fingerprint: text('fingerprint').notNull(),
    parentRunId: uuid('parent_run_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    analysisMode: text('analysis_mode').notNull(),
    policyVersion: text('policy_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    adapterVersion: text('adapter_version').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    effectiveLimits: jsonb('effective_limits').notNull(),
    portfolioRevision: integer('portfolio_revision').notNull(),
    status: text('status').notNull().default('running'),
    completeness: text('completeness').notNull().default('limited'),
    limitReasons: jsonb('limit_reasons').notNull().default([]),
    events: jsonb('events').notNull().default([]),
    continuation: jsonb('continuation'),
    history: jsonb('history').notNull().default([]),
    previewId: uuid('preview_id').references(() => portfolioPreviews.id),
    usage: jsonb('usage'),
    reservedCost: money('reserved_cost').notNull().default('0'),
    estimatedCost: money('estimated_cost'),
    priceVersion: text('price_version'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    startedAt: utc('started_at').notNull().defaultNow(),
    finishedAt: utc('finished_at'),
  },
  (t) => [
    check(
      'agent_run_mode',
      sql`${t.analysisMode} in ('quick','standard','extensive')`,
    ),
    check(
      'agent_run_status',
      sql`${t.status} in ('running','completed','failed','cancelled','interrupted')`,
    ),
    check(
      'agent_run_completeness',
      sql`${t.completeness} in ('complete','limited')`,
    ),
    check('agent_run_cost_nonnegative', sql`${t.reservedCost} >= 0`),
  ],
);
export const agentToolCalls = pgTable(
  'agent_tool_calls',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id),
    callId: text('call_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    output: jsonb('output').notNull(),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.callId] })],
);

// Durable market HTTP rate gates, including metadata calls.
export const marketProviderLimits = pgTable(
  'market_provider_limits',
  {
    provider: text('provider').primaryKey(),
    nextAllowedAt: utc('next_allowed_at').notNull(),
  },
  (t) => [
    check('market_limit_provider', sql`${t.provider} in ('massive','ibkr')`),
  ],
);

export const researchCompanies = pgTable('research_companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  symbol: text('symbol').notNull().unique(),
  name: text('name').notNull(),
  cik: text('cik'),
  createdAt: utc('created_at').notNull().defaultNow(),
});
export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => researchCompanies.id),
    provider: text('provider').notNull(),
    upstreamKey: text('upstream_key').notNull(),
    title: text('title').notNull(),
    form: text('form').notNull(),
    url: text('url'),
    publishedAt: utc('published_at'),
    observedAt: utc('observed_at').notNull(),
    availableAt: utc('available_at').notNull(),
    hash: text('hash').notNull(),
    revision: integer('revision').notNull(),
    mime: text('mime').notNull(),
    rawBase64: text('raw_base64').notNull(),
  },
  (t) => [
    uniqueIndex('source_document_content').on(
      t.companyId,
      t.provider,
      t.upstreamKey,
      t.hash,
    ),
    uniqueIndex('source_document_revision').on(
      t.companyId,
      t.provider,
      t.upstreamKey,
      t.revision,
    ),
    check('source_provider', sql`${t.provider} in ('fixture','sec','upload')`),
    check('source_revision', sql`${t.revision}>0`),
    check(
      'source_available',
      sql`${t.availableAt}>=${t.observedAt} and (${t.publishedAt} is null or ${t.availableAt}>=${t.publishedAt})`,
    ),
    index('source_company_available').on(t.companyId, t.availableAt),
  ],
);
export const documentChunks = pgTable(
  'document_chunks',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => sourceDocuments.id),
    chunkIndex: integer('chunk_index').notNull(),
    page: integer('page'),
    text: text('text').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.chunkIndex] }),
    index('document_search').using(
      'gin',
      sql`to_tsvector('english',${t.text})`,
    ),
    check('chunk_index_nonnegative', sql`${t.chunkIndex}>=0`),
    check('chunk_page_positive', sql`${t.page} is null or ${t.page}>0`),
  ],
);
export const companyFacts = pgTable(
  'company_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => sourceDocuments.id),
    metric: text('metric').notNull(),
    unit: text('unit').notNull(),
    periodStart: date('period_start'),
    periodEnd: date('period_end').notNull(),
    value: numeric('value').notNull(),
    accession: text('accession').notNull(),
    filed: date('filed').notNull(),
  },
  (t) => [
    index('fact_document_metric').on(t.documentId, t.metric),
    check(
      'fact_period',
      sql`${t.periodStart} is null or ${t.periodStart}<=${t.periodEnd}`,
    ),
  ],
);
export const researchFindings = pgTable(
  'research_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => sourceDocuments.id),
    chunkIndex: integer('chunk_index').notNull(),
    claim: text('claim').notNull(),
    category: text('category').notNull(),
    extractorVersion: text('extractor_version').notNull(),
  },
  (t) => [
    check(
      'finding_category',
      sql`${t.category} in ('guidance','risk','business','financial')`,
    ),
  ],
);
export const researchImports = pgTable(
  'research_imports',
  {
    id: uuid('id').primaryKey(),
    symbol: text('symbol').notNull(),
    provider: text('provider').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull(),
    startedAt: utc('started_at').notNull().defaultNow(),
    finishedAt: utc('finished_at'),
    documentIds: jsonb('document_ids').$type<string[]>().notNull().default([]),
    error: text('error'),
  },
  (t) => [
    check(
      'research_import_status',
      sql`${t.status} in ('running','completed','failed','interrupted')`,
    ),
    index('research_import_symbol').on(t.symbol, t.startedAt),
  ],
);
