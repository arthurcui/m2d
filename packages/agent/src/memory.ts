import { createHash } from 'node:crypto';
import { z } from 'zod';
import { workbookMappingSchema } from '@m2d/portfolio';
import type {
  WorkbookInspection,
  WorkbookMapping,
  ImportField,
} from '@m2d/portfolio';
export type ImportMemory = {
  version: 1 | 2;
  rules?: InterpretationRule[];
  signature: string;
  mapping: WorkbookMapping;
  sheets: { name: string; length: number }[];
  headers: { sheet: string; row: number; cells: string[] }[];
  accounts: { sheet: string; column: number | null; values: string[] }[];
};
const ruleSchema = z
  .object({
    sheet: z.string().min(1),
    headerRow: z.number().int().positive(),
    match: z
      .array(
        z
          .object({
            column: z.number().int().nonnegative(),
            value: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    field: z.enum(['AssetType', 'Currency', 'Multiplier', 'Deliverable']),
    value: z.string().min(1),
  })
  .strict()
  .refine((r) =>
    r.field === 'AssetType'
      ? ['STOCK', 'ETF', 'OPTION', 'CASH'].includes(r.value)
      : r.field === 'Currency'
        ? /^[A-Z]{3}$/.test(r.value)
        : r.field === 'Multiplier'
          ? /^\d+(?:\.\d+)?$/.test(r.value) && !/^0+(?:\.0+)?$/.test(r.value)
          : r.value === 'STANDARD',
  );
export type InterpretationRule = z.infer<typeof ruleSchema>;
const profileSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    signature: z.string(),
    mapping: workbookMappingSchema,
    rules: z.array(ruleSchema).max(10000).optional(),
    sheets: z.array(
      z.object({ name: z.string(), length: z.number().int().nonnegative() }),
    ),
    headers: z.array(
      z.object({
        sheet: z.string(),
        row: z.number().int().positive(),
        cells: z.array(z.string()),
      }),
    ),
    accounts: z.array(
      z.object({
        sheet: z.string(),
        column: z.number().int().nonnegative().nullable(),
        values: z.array(z.string()),
      }),
    ),
  })
  .strict();
const clean = (v: string) => v.trim().toUpperCase();
const safeDefaults = new Set<ImportField>([
  'AccountKey',
  'DisplayName',
  'Institution',
  'AccountType',
  'BaseCurrency',
  'Active',
  'AssetType',
  'Currency',
  'Exchange',
]);
export function learnImportMemory(
  inspection: WorkbookInspection,
  mapping: WorkbookMapping,
  previous?: unknown,
): ImportMemory | null {
  const rules: InterpretationRule[] = [];
  const corrections = new Map<string, WorkbookMapping['overrides'][number]>();
  for (const table of mapping.tables) {
    const values = Object.fromEntries(
      Object.entries(table.defaults).filter(([f]) =>
        ['Multiplier', 'Deliverable'].includes(f),
      ),
    );
    if (!Object.keys(values).length) continue;
    const sheet = inspection.sheets.find((s) => s.name === table.sheet);
    for (let row = table.firstRow; row <= table.lastRow; row++) {
      if (
        !/^(OPT|OPTION|OPTIONS|CALL|PUT)$/i.test(
          sheet?.rows[row - 1]?.[table.columns.AssetType ?? -1]?.trim() ?? '',
        )
      )
        continue;
      corrections.set(`${table.sheet}:${row}`, {
        sheet: table.sheet,
        row,
        values,
        reason: 'Confirmed contract terms',
      });
    }
  }
  for (const override of mapping.overrides)
    corrections.set(`${override.sheet}:${override.row}`, {
      ...override,
      values: {
        ...corrections.get(`${override.sheet}:${override.row}`)?.values,
        ...override.values,
      },
    });
  for (const override of corrections.values()) {
    const table = mapping.tables.find(
      (t) =>
        t.sheet === override.sheet &&
        override.row >= t.firstRow &&
        override.row <= t.lastRow,
    );
    const cells = inspection.sheets.find((s) => s.name === override.sheet)
      ?.rows[override.row - 1];
    if (!table || !cells) continue;
    for (const [field, value] of Object.entries(override.values)) {
      let match: InterpretationRule['match'] = [];
      if (field === 'AssetType' || field === 'Currency') {
        const column = table.columns[field];
        const token = column === undefined ? '' : clean(cells[column] ?? '');
        if (!token || column === undefined) continue;
        const meanings: Record<string, string> = {
          STK: 'STOCK',
          STOCKS: 'STOCK',
          EQUITY: 'STOCK',
          EQUITIES: 'STOCK',
          OPT: 'OPTION',
          OPTIONS: 'OPTION',
          STOCK: 'STOCK',
          OPTION: 'OPTION',
          ETF: 'ETF',
          CASH: 'CASH',
        };
        // A one-row correction to an already meaningful value is not a global alias.
        if (
          field === 'AssetType' &&
          meanings[token] &&
          meanings[token] !== value
        )
          continue;
        if (field === 'Currency' && /^[A-Z]{3}$/.test(token) && token !== value)
          continue;
        match = [{ column, value: token }];
        if (
          field === 'AssetType' &&
          value === 'CASH' &&
          /^[A-Z]{3}$/.test(token)
        ) {
          const description = table.columns.Description;
          if (description === undefined || !cells[description]?.trim())
            continue;
          match.push({
            column: description,
            value: clean(cells[description]!),
          });
        }
      } else if (field === 'Multiplier' || field === 'Deliverable') {
        // Contract terms belong to this source contract, never all future options.
        for (const key of ['AssetType', 'Symbol', 'Description'] as const) {
          const column = table.columns[key];
          if (column === undefined || !cells[column]?.trim()) {
            match = [];
            break;
          }
          match.push({ column, value: clean(cells[column]!) });
        }
      }
      const rule = ruleSchema.safeParse({
        sheet: table.sheet,
        headerRow: table.headerRow,
        match,
        field,
        value,
      });
      if (rule.success) rules.push(rule.data);
    }
  }
  if (
    (mapping.overrides.length && !rules.length) ||
    mapping.cashBalances.length ||
    !mapping.tables.length ||
    mapping.tables.some((t) =>
      Object.keys(t.defaults).some(
        (f) =>
          !safeDefaults.has(f as ImportField) &&
          !['Multiplier', 'Deliverable'].includes(f),
      ),
    )
  )
    return null;
  const headers = mapping.tables.map((t) => ({
    sheet: t.sheet,
    row: t.headerRow,
    cells:
      inspection.sheets.find((s) => s.name === t.sheet)?.rows[
        t.headerRow - 1
      ] ?? [],
  }));
  if (headers.some((h) => h.row === 0 || !h.cells.length)) return null;
  if (
    mapping.excludedRows.some(
      (e) =>
        inspection.sheets
          .find((s) => s.name === e.sheet)
          ?.rows[e.row - 1]?.some((v) => v.trim()) &&
        e.row >=
          Math.min(
            ...headers.filter((h) => h.sheet === e.sheet).map((h) => h.row),
          ),
    )
  )
    return null;
  for (const excluded of mapping.excludedRows)
    if (
      inspection.sheets
        .find((s) => s.name === excluded.sheet)
        ?.rows[excluded.row - 1]?.some((v) => v.trim())
    )
      headers.push({
        sheet: excluded.sheet,
        row: excluded.row,
        cells:
          inspection.sheets.find((s) => s.name === excluded.sheet)?.rows[
            excluded.row - 1
          ] ?? [],
      });
  const accounts: ImportMemory['accounts'] = [];
  for (const table of mapping.tables) {
    const sheet = inspection.sheets.find((s) => s.name === table.sheet)!;
    const col = table.columns.AccountKey;
    if (table.columns.Institution !== undefined)
      accounts.push({
        sheet: sheet.name,
        column: table.columns.Institution,
        values: [
          ...new Set(
            sheet.rows
              .slice(table.firstRow - 1, table.lastRow)
              .map((r) => clean(r[table.columns.Institution!] ?? ''))
              .filter(Boolean),
          ),
        ].sort(),
      });
    if (
      table.defaults.Institution &&
      table.defaults.Institution !== 'Self-reported' &&
      !sheet.rows
        .flat()
        .some((v) => clean(v) === clean(table.defaults.Institution!))
    )
      return null;
    if (col !== undefined) {
      accounts.push({
        sheet: sheet.name,
        column: col,
        values: [
          ...new Set(
            sheet.rows
              .slice(table.firstRow - 1, table.lastRow)
              .map((r) => clean(r[col] ?? ''))
              .filter(Boolean),
          ),
        ].sort(),
      });
    } else {
      const key = table.defaults.AccountKey;
      if (
        !key ||
        (clean(key).replace(/[^A-Z0-9]/g, '') !==
          clean(sheet.name).replace(/[^A-Z0-9]/g, '') &&
          !mapping.accountDecisions?.some(
            (d) =>
              d.kind === 'rename' &&
              d.sheet === sheet.name &&
              d.accountKey === key,
          ))
      )
        return null;
      accounts.push({
        sheet: sheet.name,
        column: null,
        values: [clean(sheet.name)],
      });
    }
  }
  const safe = structuredClone(mapping);
  safe.overrides = [];
  safe.excludedRows = safe.excludedRows.filter((e) =>
    inspection.sheets
      .find((s) => s.name === e.sheet)
      ?.rows[e.row - 1]?.some((v) => v.trim()),
  );
  safe.tables.forEach((t) => {
    t.defaults = Object.fromEntries(
      Object.entries(t.defaults).filter(([field]) =>
        safeDefaults.has(field as ImportField),
      ),
    );
  });
  const signature = createHash('sha256')
    .update(JSON.stringify({ headers, accounts }))
    .digest('hex');
  const old = profileSchema.safeParse(previous);
  const merged = new Map<string, InterpretationRule>();
  const key = (r: InterpretationRule) =>
    JSON.stringify([r.sheet, r.headerRow, r.match, r.field]);
  if (old.success && old.data.signature === signature)
    for (const rule of old.data.rules ?? []) merged.set(key(rule), rule);
  const current = new Map<string, InterpretationRule>();
  for (const rule of rules) {
    if (current.has(key(rule)) && current.get(key(rule))!.value !== rule.value)
      return null;
    current.set(key(rule), rule);
  }
  for (const [id, rule] of current) merged.set(id, rule);
  return {
    version: 2,
    rules: [...merged.values()],
    signature,
    mapping: safe,
    headers,
    accounts,
    sheets: inspection.sheets.map((s) => ({
      name: s.name,
      length: s.rows.length,
    })),
  };
}
export function recallImportMemory(
  rawMemory: unknown,
  inspection: WorkbookInspection,
): WorkbookMapping | null {
  const parsed = profileSchema.safeParse(rawMemory);
  if (!parsed.success) return null;
  const memory = parsed.data;
  if (
    memory.mapping.overrides.length ||
    memory.mapping.cashBalances.length ||
    memory.mapping.tables.some((t) =>
      Object.keys(t.defaults).some(
        (field) => !safeDefaults.has(field as ImportField),
      ),
    )
  )
    return null;
  if (
    memory.rules?.some(
      (r) =>
        ['Multiplier', 'Deliverable'].includes(r.field) && r.match.length !== 3,
    )
  )
    return null;
  if (memory.sheets.length !== inspection.sheets.length) return null;
  if (
    memory.sheets.some((s) => !inspection.sheets.some((n) => n.name === s.name))
  )
    return null;
  if (
    memory.headers.some(
      (h) =>
        JSON.stringify(
          inspection.sheets.find((s) => s.name === h.sheet)?.rows[h.row - 1],
        ) !== JSON.stringify(h.cells),
    )
  )
    return null;
  const mapping = structuredClone(memory.mapping);
  for (const table of mapping.tables) {
    const old = memory.sheets.find((s) => s.name === table.sheet),
      sheet = inspection.sheets.find((s) => s.name === table.sheet);
    if (!old || !sheet) return null;
    if (table.lastRow === old.length) table.lastRow = sheet.rows.length;
    if (table.lastRow > sheet.rows.length) return null;
  }
  const candidate = learnImportMemory(inspection, mapping);
  if (candidate?.signature !== memory.signature) return null;
  for (const rule of memory.version === 2 ? (memory.rules ?? []) : []) {
    const table = mapping.tables.find(
      (t) => t.sheet === rule.sheet && t.headerRow === rule.headerRow,
    );
    const sheet = inspection.sheets.find((s) => s.name === rule.sheet);
    if (!table || !sheet) return null;
    for (let row = table.firstRow; row <= table.lastRow; row++) {
      if (
        !rule.match.every(
          (m) => clean(sheet.rows[row - 1]?.[m.column] ?? '') === m.value,
        )
      )
        continue;
      let override = mapping.overrides.find(
        (o) => o.sheet === rule.sheet && o.row === row,
      );
      if (!override) {
        override = {
          sheet: rule.sheet,
          row,
          values: {},
          reason:
            'Previously confirmed interpretation rule matched current source values.',
        };
        mapping.overrides.push(override);
      }
      if (
        override.values[rule.field] &&
        override.values[rule.field] !== rule.value
      )
        return null;
      override.values[rule.field] = rule.value;
    }
  }
  return mapping;
}
