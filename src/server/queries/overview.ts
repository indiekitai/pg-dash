import type { Pool } from "pg";

export async function getOverview(pool: Pool) {
  const client = await pool.connect();
  try {
    const version = await client.query("SHOW server_version");
    const uptime = await client.query(
      "SELECT to_char(now() - pg_postmaster_start_time(), 'DD \"d\" HH24 \"h\" MI \"m\"') AS uptime"
    );
    const dbSize = await client.query(
      "SELECT pg_size_pretty(pg_database_size(current_database())) AS size"
    );
    const dbCount = await client.query(
      "SELECT count(*)::int AS count FROM pg_database WHERE NOT datistemplate"
    );
    const connections = await client.query(`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active') AS active,
        (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'idle') AS idle,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
    `);

    return {
      version: version.rows[0].server_version,
      uptime: uptime.rows[0].uptime,
      dbSize: dbSize.rows[0].size,
      databaseCount: dbCount.rows[0].count,
      connections: connections.rows[0],
    };
  } finally {
    client.release();
  }
}
