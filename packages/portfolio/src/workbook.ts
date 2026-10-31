import { z } from 'zod';
import { currency } from './contracts.js';
export const importFields = [
  'AccountKey',
  'DisplayName',
  'Institution',
  'AccountType',
  'BaseCurrency',
  'Active',
  'AssetType',
  'Symbol',
  'Description',
  'Exchange',
  'Currency',
  'Quantity',
  'AverageCost',
  'TotalCost',
  'Balance',
  'OptionRight',
  'Expiration',
  'Strike',
  'Multiplier',
  'Underlying',
  'Deliverable',
  'Side',
  'Notes',
  'OptionGroup',
  'TransactionDate',
] as const;
export type ImportField = (typeof importFields)[number];
export const accountDecisionSchema = z.discriminatedUnion('kind', [
  z
    .object({ sheet: z.string().min(1).max(100), kind: z.literal('new') })
    .strict(),
  z
    .object({
      sheet: z.string().min(1).max(100),
      kind: z.literal('rename'),
      accountKey: z.string().min(1).max(64),
    })
    .strict(),
]);
export type AccountDecision = z.infer<typeof accountDecisionSchema>;
export const importValuesSchema = z.partialRecord(
  z.enum(importFields),
  z.string().max(1000),
);
export const importTableSchema = z
  .object({
    sheet: z.string().min(1).max(100),
    headerRow: z.number().int().min(0).max(5000),
    firstRow: z.number().int().min(1).max(5001),
    lastRow: z.number().int().min(0).max(5000),
    kind: z.enum(['positions', 'cash', 'mixed', 'accounts', 'unresolved']),
    columns: z.partialRecord(
      z.enum(importFields),
      z.number().int().min(0).max(99),
    ),
    defaults: importValuesSchema,
  })
  .strict();
export const workbookMappingSchema = z
  .object({
    version: z.literal(1),
    accountDecisions: z.array(accountDecisionSchema).max(100).default([]),
    cashBalances: z
      .array(
        z
          .object({
            account: z.string().trim().min(1).max(120),
            currency,
            balance: z.string().min(1).max(100),
            reason: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(200)
      .default([]),
    tables: z.array(importTableSchema).max(100),
    excludedRows: z
      .array(
        z
          .object({
            sheet: z.string(),
            row: z.number().int().min(1).max(5000),
            reason: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(10000),
    overrides: z
      .array(
        z
          .object({
            sheet: z.string(),
            row: z.number().int().min(1).max(5000),
            values: importValuesSchema,
            reason: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(2200),
  })
  .strict();
export type ImportTable = z.infer<typeof importTableSchema>;
export type WorkbookMapping = z.infer<typeof workbookMappingSchema>;
export type WorkbookSheet = { name: string; rows: string[][] };
export type WorkbookInspection = {
  sheets: WorkbookSheet[];
  mapping: WorkbookMapping;
  warnings: string[];
};
export type ImportSource = {
  sheet: string;
  row: number;
  kind: string;
  accountKey: string;
  identity: string;
};
