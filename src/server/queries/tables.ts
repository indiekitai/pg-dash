import type { Pool } from "pg";

export async function getTables(pool: Pool) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT
        schemaname AS schema,
        relname AS name,
        pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
        pg_total_relation_size(relid) AS size_bytes,
        n_live_tup AS rows,
        n_dead_tup AS dead_tuples,
        CASE WHEN n_live_tup > 0 
          THEN round(n_dead_tup::numeric / n_live_tup * 100, 1) 
          ELSE 0 END AS dead_pct
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
    `);
    return r.rows;
  } finally {
    client.release();
  }
}
