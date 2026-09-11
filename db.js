import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn('[como-asi] DATABASE_URL is not configured');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function healthcheckDb() {
  const result = await query("select current_database() as database, current_user as role, current_schema() as schema, now() as now");
  return result.rows[0];
}
