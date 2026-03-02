import type { Pool } from "pg";

export async function getDatabases(pool: Pool) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT datname AS name,
        pg_size_pretty(pg_database_size(datname)) AS size,
        pg_database_size(datname) AS size_bytes
      FROM pg_database
      WHERE NOT datistemplate
      ORDER BY pg_database_size(datname) DESC
    `);
    return r.rows;
  } finally {
    client.release();
  }
}
