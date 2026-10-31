/* global console */
import { mkdir, writeFile } from 'node:fs/promises';
import {
  sevenAccountFixture,
  workbook,
} from '../packages/ingestion/dist/index.js';
await mkdir('data/exports', { recursive: true });
await writeFile(
  'data/exports/m1-seven-accounts.xlsx',
  await workbook(sevenAccountFixture()),
);
console.log(
  'Created data/exports/m1-seven-accounts.xlsx — fictional data; import only into a disposable workspace.',
);
