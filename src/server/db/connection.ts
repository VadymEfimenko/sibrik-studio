import pg, { type PoolClient } from 'pg';

export function createPool(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 12,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  // pg emits errors from idle clients outside query promises. It removes that
  // client automatically; a listener keeps a database restart from killing us.
  pool.on('error', () => console.error('PostgreSQL connection lost; the pool will reconnect.'));
  return pool;
}
export type Database = ReturnType<typeof createPool>;
export type Transaction = PoolClient;

export async function transaction<T>(
  pool: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}

export async function notify(tx: Transaction): Promise<void> {
  // PostgreSQL delivers transactional NOTIFY only after a successful commit.
  await tx.query("SELECT pg_notify('studio_updates', 'changed')");
}
