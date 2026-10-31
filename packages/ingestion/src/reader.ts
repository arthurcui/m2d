import readExcel from 'read-excel-file/node';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { PortfolioError, type WorkbookSheet } from '@m2d/portfolio';
export const MAX_UPLOAD = 2 * 1024 * 1024;
export async function readTables(
  bytes: Buffer,
  cachedFormulas = false,
): Promise<{ sheets: WorkbookSheet[]; warnings: string[] }> {
  if (bytes.length > MAX_UPLOAD)
    throw new PortfolioError(
      'UPLOAD_TOO_LARGE',
      'Workbook limit is 2 MiB.',
      413,
    );
  let total = 0,
    count = 0,
    formulas = 0;
  const entries = unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize;
      count++;
      if (
        total > 16 * 1024 * 1024 ||
        f.originalSize > 8 * 1024 * 1024 ||
        count > 200
      )
        throw new Error('Workbook expands beyond the allowed size.');
      return true;
    },
  });
  for (const [path, data] of Object.entries(entries)) {
    if (/vbaProject|externalLinks/i.test(path))
      throw new Error('Macros and external links are not supported.');
    if (!/\.(xml|rels)$/i.test(path)) continue;
    const xml = strFromU8(data);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new Error('XML entities are not supported.');
    if (/<(?:\w+:)?f(?:\s|\/|>)/.test(xml)) {
      if (!cachedFormulas)
        throw new Error(
          'Formula cells are not accepted in the canonical import. Use flexible import to review saved formula values.',
        );
      for (const cell of xml.matchAll(
        /<(?:\w+:)?c\b[^>]*>[\s\S]*?<\/(?:\w+:)?c>/g,
      ))
        if (/<(?:\w+:)?f(?:\s|\/|>)/.test(cell[0])) {
          formulas++;
          if (!/<(?:\w+:)?v\b[^>]*>[^<]+<\/(?:\w+:)?v>/.test(cell[0]))
            throw new Error(
              'A formula has no saved value. Recalculate and save the workbook in Excel, or paste values, before importing.',
            );
        }
    }
    if (path.startsWith('xl/worksheets/'))
      for (const m of xml.matchAll(/\br=["']([A-Z]*)(\d+)["']/g)) {
        const col = [...m[1]!].reduce(
          (n, c) => n * 26 + c.charCodeAt(0) - 64,
          0,
        );
        if (Number(m[2]) > 5000 || col > 100)
          throw new Error('Worksheet exceeds 5000 rows or 100 columns.');
      }
  }
  const raw = await readExcel(Buffer.from(zipSync(entries)), {
    parseNumber: (v) => v,
  });
  if (raw.length > 30 || new Set(raw.map((s) => s.sheet)).size !== raw.length)
    throw new Error('Use at most 30 uniquely named sheets.');
  let cells = 0,
    rows = 0;
  const sheets = raw.map((s) => ({
    name: s.sheet,
    rows: s.data.map((r) => {
      rows++;
      cells += r.length;
      if (rows > 10000 || cells > 100000)
        throw new Error('Workbook exceeds 10000 rows or 100000 cells.');
      return r.map((v) =>
        v instanceof Date
          ? v.toISOString().slice(0, 10)
          : v === null
            ? ''
            : String(v),
      );
    }),
  }));
  return {
    sheets,
    warnings: formulas
      ? [
          `${formulas} formula cells use saved values; formulas are not executed. Verify that the workbook was recalculated before saving.`,
        ]
      : [],
  };
}
