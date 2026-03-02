import type { Pool } from "pg";

export interface Activity {
  pid: number;
  query: string;
  state: string;
  wait_event: string | null;
  wait_event_type: string | null;
  duration: string | null;
  client_addr: string | null;
  application_name: string;
  backend_start: string;
}

export async function getActivity(pool: Pool): Promise<Activity[]> {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT
        pid,
        COALESCE(query, '') AS query,
        COALESCE(state, 'unknown') AS state,
        wait_event,
        wait_event_type,
        CASE WHEN state = 'active' THEN (now() - query_start)::text
             WHEN state = 'idle in transaction' THEN (now() - state_change)::text
             ELSE NULL END AS duration,
        client_addr::text,
        COALESCE(application_name, '') AS application_name,
        backend_start::text
      FROM pg_stat_activity
      WHERE pid != pg_backend_pid()
        AND state IS NOT NULL
      ORDER BY
        CASE state
          WHEN 'active' THEN 1
          WHEN 'idle in transaction' THEN 2
          ELSE 3
        END,
        query_start ASC NULLS LAST
    `);
    return r.rows;
  } finally {
    client.release();
  }
}
