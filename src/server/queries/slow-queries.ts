import type { Pool } from "pg";

export interface SlowQuery {
  queryid: string;
  query: string;
  calls: number;
  total_time: number;
  mean_time: number;
  rows: number;
  total_time_pretty: string;
  mean_time_pretty: string;
}

export async function getSlowQueries(pool: Pool): Promise<SlowQuery[]> {
  const client = await pool.connect();
  try {
    // Check if pg_stat_statements is available
    const extCheck = await client.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'"
    );
    if (extCheck.rows.length === 0) {
      return [];
    }

    const r = await client.query(`
      SELECT
        queryid::text,
        query,
        calls::int,
        total_exec_time AS total_time,
        mean_exec_time AS mean_time,
        rows::int,
        round(total_exec_time::numeric / 1000, 2)::text || 's' AS total_time_pretty,
        round(mean_exec_time::numeric, 2)::text || 'ms' AS mean_time_pretty
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_stat%'
        AND query NOT LIKE '%pg_catalog%'
      ORDER BY total_exec_time DESC
      LIMIT 50
    `);
    return r.rows;
  } catch {
    // pg_stat_statements might not be accessible
    return [];
  } finally {
    client.release();
  }
}
