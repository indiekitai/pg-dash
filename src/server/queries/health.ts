import type { Pool } from "pg";

export interface HealthIssue {
  severity: "info" | "warning" | "critical";
  check: string;
  description: string;
  sql?: string;
}

export interface HealthResult {
  score: number; // 0-100
  grade: string; // A-F
  issues: HealthIssue[];
}

function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function computeScore(issues: HealthIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === "critical") score -= 15;
    else if (issue.severity === "warning") score -= 7;
    else score -= 2;
  }
  return Math.max(0, Math.min(100, score));
}

export async function getHealth(pool: Pool): Promise<HealthResult> {
  const client = await pool.connect();
  const issues: HealthIssue[] = [];

  try {
    // 1. Cache hit ratio
    try {
      const r = await client.query(`
        SELECT 
          CASE WHEN (blks_hit + blks_read) = 0 THEN 1
          ELSE blks_hit::float / (blks_hit + blks_read) END AS ratio
        FROM pg_stat_database WHERE datname = current_database()
      `);
      const ratio = parseFloat(r.rows[0]?.ratio ?? "1");
      if (ratio < 0.95) {
        issues.push({
          severity: "critical",
          check: "cache_hit_ratio",
          description: `Cache hit ratio is ${(ratio * 100).toFixed(1)}% (should be > 99%)`,
          sql: "SHOW shared_buffers; -- Consider increasing shared_buffers",
        });
      } else if (ratio < 0.99) {
        issues.push({
          severity: "warning",
          check: "cache_hit_ratio",
          description: `Cache hit ratio is ${(ratio * 100).toFixed(1)}% (should be > 99%)`,
          sql: "SHOW shared_buffers; -- Consider increasing shared_buffers",
        });
      }
    } catch {}

    // 2. Connection utilization
    try {
      const r = await client.query(`
        SELECT count(*)::float / (SELECT setting::float FROM pg_settings WHERE name = 'max_connections') AS ratio
        FROM pg_stat_activity
      `);
      const ratio = parseFloat(r.rows[0]?.ratio ?? "0");
      if (ratio > 0.9) {
        issues.push({
          severity: "critical",
          check: "connection_utilization",
          description: `Connection utilization at ${(ratio * 100).toFixed(0)}% (> 90%)`,
          sql: "ALTER SYSTEM SET max_connections = 200; SELECT pg_reload_conf();",
        });
      } else if (ratio > 0.8) {
        issues.push({
          severity: "warning",
          check: "connection_utilization",
          description: `Connection utilization at ${(ratio * 100).toFixed(0)}% (> 80%)`,
          sql: "ALTER SYSTEM SET max_connections = 200; SELECT pg_reload_conf();",
        });
      }
    } catch {}

    // 3. Long-running queries (> 5min)
    try {
      const r = await client.query(`
        SELECT pid, now() - query_start AS duration, left(query, 100) AS query
        FROM pg_stat_activity
        WHERE state = 'active' AND now() - query_start > interval '5 minutes'
          AND pid != pg_backend_pid()
      `);
      for (const row of r.rows) {
        issues.push({
          severity: "warning",
          check: "long_running_queries",
          description: `Query running for ${row.duration} (PID ${row.pid}): ${row.query}`,
          sql: `SELECT pg_terminate_backend(${row.pid});`,
        });
      }
    } catch {}

    // 4. Idle in transaction (> 5min)
    try {
      const r = await client.query(`
        SELECT pid, now() - state_change AS duration
        FROM pg_stat_activity
        WHERE state = 'idle in transaction' AND now() - state_change > interval '5 minutes'
      `);
      for (const row of r.rows) {
        issues.push({
          severity: "warning",
          check: "idle_in_transaction",
          description: `Connection idle in transaction for ${row.duration} (PID ${row.pid})`,
          sql: `SELECT pg_terminate_backend(${row.pid});`,
        });
      }
    } catch {}

    // 5. Table bloat (dead tuples > 10% of live)
    try {
      const r = await client.query(`
        SELECT schemaname, relname, n_dead_tup, n_live_tup,
          CASE WHEN n_live_tup > 0 THEN n_dead_tup::float / n_live_tup ELSE 0 END AS ratio
        FROM pg_stat_user_tables
        WHERE n_live_tup > 1000 AND n_dead_tup::float / GREATEST(n_live_tup, 1) > 0.1
        ORDER BY n_dead_tup DESC LIMIT 10
      `);
      for (const row of r.rows) {
        issues.push({
          severity: "warning",
          check: "table_bloat",
          description: `${row.schemaname}.${row.relname}: ${row.n_dead_tup} dead tuples (${(row.ratio * 100).toFixed(0)}% of live)`,
          sql: `VACUUM ANALYZE ${row.schemaname}.${row.relname};`,
        });
      }
    } catch {}

    // 6. Missing primary keys
    try {
      const r = await client.query(`
        SELECT c.relname AS table_name, n.nspname AS schema
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relkind = 'r' AND n.nspname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint con
            WHERE con.conrelid = c.oid AND con.contype = 'p'
          )
      `);
      for (const row of r.rows) {
        issues.push({
          severity: "warning",
          check: "missing_primary_keys",
          description: `Table ${row.schema}.${row.table_name} has no primary key`,
          sql: `ALTER TABLE ${row.schema}.${row.table_name} ADD COLUMN id SERIAL PRIMARY KEY;`,
        });
      }
    } catch {}

    // 7. Unused indexes
    try {
      const r = await client.query(`
        SELECT schemaname, relname, indexrelname, idx_scan
        FROM pg_stat_user_indexes
        WHERE idx_scan = 0
          AND indexrelname NOT LIKE '%_pkey'
          AND schemaname = 'public'
        ORDER BY pg_relation_size(indexrelid) DESC LIMIT 10
      `);
      for (const row of r.rows) {
        issues.push({
          severity: "info",
          check: "unused_indexes",
          description: `Index ${row.indexrelname} on ${row.relname} has never been used`,
          sql: `DROP INDEX ${row.schemaname}.${row.indexrelname};`,
        });
      }
    } catch {}

    // 8. Duplicate indexes
    try {
      const r = await client.query(`
        SELECT array_agg(indexrelid::regclass) AS indexes, indrelid::regclass AS table_name
        FROM pg_index
        GROUP BY indrelid, indkey
        HAVING count(*) > 1
      `);
      for (const row of r.rows) {
        issues.push({
          severity: "warning",
          check: "duplicate_indexes",
          description: `Duplicate indexes on ${row.table_name}: ${row.indexes}`,
          sql: `-- Review and drop one of: ${row.indexes}`,
        });
      }
    } catch {}

    // 9. Seq scans on large tables
    try {
      const r = await client.query(`
        SELECT schemaname, relname, seq_scan, seq_tup_read, n_live_tup
        FROM pg_stat_user_tables
        WHERE n_live_tup > 10000 AND seq_scan > 0
        ORDER BY seq_tup_read DESC LIMIT 10
      `);
      for (const row of r.rows) {
        if (row.seq_scan > 100) {
          issues.push({
            severity: "info",
            check: "seq_scans_large_tables",
            description: `${row.relname}: ${row.seq_scan} sequential scans (${row.n_live_tup} rows)`,
            sql: `-- Consider adding indexes to ${row.schemaname}.${row.relname}`,
          });
        }
      }
    } catch {}

    // 10. VACUUM/ANALYZE never run
    try {
      const r = await client.query(`
        SELECT schemaname, relname
        FROM pg_stat_user_tables
        WHERE last_vacuum IS NULL AND last_autovacuum IS NULL
          AND n_live_tup > 100
      `);
      for (const row of r.rows) {
        issues.push({
          severity: "info",
          check: "vacuum_never_run",
          description: `${row.schemaname}.${row.relname} has never been vacuumed`,
          sql: `VACUUM ANALYZE ${row.schemaname}.${row.relname};`,
        });
      }
    } catch {}

    try {
      const r = await client.query(`
        SELECT schemaname, relname
        FROM pg_stat_user_tables
        WHERE last_analyze IS NULL AND last_autoanalyze IS NULL
          AND n_live_tup > 100
      `);
      for (const row of r.rows) {
        // Avoid duplicating if already reported under vacuum_never_run
        if (!issues.some(i => i.check === "vacuum_never_run" && i.description.includes(row.relname))) {
          issues.push({
            severity: "info",
            check: "analyze_never_run",
            description: `${row.schemaname}.${row.relname} has never been analyzed`,
            sql: `ANALYZE ${row.schemaname}.${row.relname};`,
          });
        }
      }
    } catch {}

    const score = computeScore(issues);
    return { score, grade: gradeFromScore(score), issues };
  } finally {
    client.release();
  }
}
