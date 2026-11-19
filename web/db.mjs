import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { seedAccounts } from './accounts.mjs';

// node --env-file-if-exists=.env.web loads the local connection settings.
const options = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : { database: process.env.PGDATABASE || 'arcane_fold_web' };
export const pool = new pg.Pool({ ...options, max: 10, connectionTimeoutMillis: 6000 });
pool.on('error', () => console.error('A PostgreSQL connection closed.'));

export async function migrate() {
  await transaction(async db => {
    await db.query('select pg_advisory_xact_lock(716183309)');
    await db.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('./league.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('./decks.sql', import.meta.url), 'utf8'));
    await seedAccounts(db);
  });
}
export async function transaction(work, database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}
