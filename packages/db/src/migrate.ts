import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export async function migrateDatabase(connectionString: string) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '30s'");
    await client.query('SELECT pg_advisory_lock(20261030, 0)');
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
  } finally {
    await client.end(); // Closing also releases the session migration lock on failure.
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  migrateDatabase(url)
    .then(() => console.log('Database migrations complete'))
    .catch(() => {
      console.error(
        'Database migration failed; verify database availability and schema permissions.',
      );
      process.exitCode = 1;
    });
}
