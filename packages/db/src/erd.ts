import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as schema from './schema.js';
export function renderErd() {
  const tables = Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => getTableConfig(table))
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    '# M²D database ERD',
    '',
    'Generated from the implemented Drizzle schema. Run `pnpm docs:erd` after schema changes; `pnpm docs:erd:check` fails when this document is stale.',
    '',
    'This is the current M4 application schema. PostgreSQL also contains pg-boss-managed queue tables, which are maintained by pg-boss and omitted here. Historical baselines and interpretation results contain typed JSON snapshots; positions and cash below are the rebuildable current projections. Stable account IDs preserve history across display-name changes. Confirmed sheet aliases point back to the same account. Holding transaction dates are optional date-only metadata, not a reconstructed transaction ledger.',
    '',
    'The diagram shows declared database foreign keys. Logical references without a database foreign key (including revision baseline IDs, mapping preview IDs and JSON identifiers) are deliberately not drawn. Nullable attributes are marked in quotes.',
    '',
    '```mermaid',
    'erDiagram',
  ];
  for (const table of tables) {
    const primary = new Set([
      ...table.columns.filter((c) => c.primary),
      ...table.primaryKeys.flatMap((p) => p.columns),
    ]);
    const foreign = new Set(
      table.foreignKeys.flatMap((f) => f.reference().columns),
    );
    lines.push(`    ${table.name} {`);
    for (const column of table.columns) {
      const keys = [
        ...(primary.has(column) ? ['PK'] : []),
        ...(foreign.has(column) ? ['FK'] : []),
      ];
      lines.push(
        `        ${column.getSQLType().replace(/[^A-Za-z0-9_]/g, '_')} ${column.name}${keys.length ? ' ' + keys.join(', ') : ''}${column.notNull ? '' : ' "nullable"'}`,
      );
    }
    lines.push('    }');
  }
  for (const table of tables)
    for (const key of table.foreignKeys) {
      const ref = key.reference();
      lines.push(
        `    ${getTableConfig(ref.foreignTable).name} ${ref.columns.every((c) => c.notNull) ? '||' : '|o'}--o{ ${table.name} : "${ref.columns.map((c) => c.name).join(', ')}"`,
      );
    }
  return lines.concat('```', '').join('\n');
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const target = new URL('../../../docs/ERD.md', import.meta.url),
    expected = renderErd();
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== expected)
      throw new Error('ERD is out of date. Run pnpm docs:erd.');
    process.stdout.write('ERD matches the Drizzle schema.\n');
  } else writeFileSync(target, expected);
}
