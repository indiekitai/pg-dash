import type { Pool } from "pg";

export interface AdvisorIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  category: "performance" | "maintenance" | "schema" | "security";
  title: string;
  description: string;
  fix: string;
  impact: string;
  effort: "quick" | "moderate" | "involved";
}

export interface AdvisorResult {
  score: number;
  grade: string;
  issues: AdvisorIssue[];
  breakdown: Record<string, { score: number; grade: string; count: number }>;
}

const SEVERITY_WEIGHT = { critical: 20, warning: 8, info: 3 } as const;

export function computeAdvisorScore(issues: AdvisorIssue[]): number {
  let score = 100;
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    counts[issue.severity]++;
    const n = counts[issue.severity];
    const weight = SEVERITY_WEIGHT[issue.severity];
    // Diminishing penalty: full for first 5, half for 6-15, quarter for 16+
    if (n <= 5) score -= weight;
    else if (n <= 15) score -= weight * 0.5;
    else score -= weight * 0.25;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 50) return "D";
  return "F";
}

function computeBreakdown(issues: AdvisorIssue[]): Record<string, { score: number; grade: string; count: number }> {
  const categories = ["performance", "maintenance", "schema", "security"] as const;
  const result: Record<string, { score: number; grade: string; count: number }> = {};
  for (const cat of categories) {
    const catIssues = issues.filter((i) => i.category === cat);
    const score = computeAdvisorScore(catIssues);
    result[cat] = { score, grade: gradeFromScore(score), count: catIssues.length };
  }
  return result;
}

export async function getAdvisorReport(pool: Pool): Promise<AdvisorResult> {
  const client = await pool.connect();
  const issues: AdvisorIssue[] = [];

  try {
    // ── Performance Advisors ───────────────────────────────────────

    // Missing indexes (high seq scans on large tables)
    try {
      const r = await client.query(`
        SELECT schemaname, relname, seq_scan, seq_tup_read, n_live_tup,
          pg_size_pretty(pg_total_relation_size(relid)) AS size
        FROM pg_stat_user_tables
        WHERE n_live_tup > 10000 AND seq_scan > 100
        ORDER BY seq_tup_read DESC LIMIT 10
      `);
      for (const row of r.rows) {
        issues.push({
          id: `perf-seq-scan-${row.schemaname}-${row.relname}`,
          severity: row.seq_scan > 1000 ? "warning" : "info",
          category: "performance",
          title: `High sequential scans on ${row.relname}`,
          description: `Table ${row.schemaname}.${row.relname} (${row.n_live_tup} rows, ${row.size}) has ${row.seq_scan} sequential scans reading ${Number(row.seq_tup_read).toLocaleString()} tuples. Consider adding indexes on frequently filtered columns.`,
          fix: `-- Identify commonly filtered columns and add indexes:\n-- EXPLAIN ANALYZE SELECT * FROM ${row.schemaname}.${row.relname} WHERE <your_condition>;\nCREATE INDEX CONCURRENTLY idx_${row.relname}_<column> ON ${row.schemaname}.${row.relname} (<column>);`,
          impact: "Queries will continue to do full table scans, degrading performance as the table grows.",
          effort: "moderate",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking seq scans:", (err as Error).message);
    }

    // Bloated indexes (index size > 3x table size)
    try {
      const r = await client.query(`
        SELECT
          schemaname, relname, indexrelname,
          pg_relation_size(indexrelid) AS idx_size,
          pg_relation_size(relid) AS tbl_size,
          pg_size_pretty(pg_relation_size(indexrelid)) AS idx_size_pretty,
          pg_size_pretty(pg_relation_size(relid)) AS tbl_size_pretty
        FROM pg_stat_user_indexes
        WHERE pg_relation_size(indexrelid) > 1048576
          AND pg_relation_size(indexrelid) > pg_relation_size(relid) * 3
        ORDER BY pg_relation_size(indexrelid) DESC LIMIT 10
      `);
      for (const row of r.rows) {
        issues.push({
          id: `perf-bloated-idx-${row.indexrelname}`,
          severity: "warning",
          category: "performance",
          title: `Bloated index ${row.indexrelname}`,
          description: `Index ${row.indexrelname} on ${row.relname} is ${row.idx_size_pretty} but the table is only ${row.tbl_size_pretty}. The index may need rebuilding.`,
          fix: `REINDEX INDEX CONCURRENTLY ${row.schemaname}.${row.indexrelname};`,
          impact: "Bloated indexes waste disk space and slow down queries that use them.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking bloated indexes:", (err as Error).message);
    }

    // Table bloat (dead tuples > 10%)
    try {
      const r = await client.query(`
        SELECT schemaname, relname, n_dead_tup, n_live_tup,
          CASE WHEN n_live_tup > 0 THEN round(n_dead_tup::numeric / n_live_tup * 100, 1) ELSE 0 END AS dead_pct,
          pg_size_pretty(pg_total_relation_size(relid)) AS size
        FROM pg_stat_user_tables
        WHERE n_live_tup > 1000 AND n_dead_tup::float / GREATEST(n_live_tup, 1) > 0.1
        ORDER BY n_dead_tup DESC LIMIT 10
      `);
      for (const row of r.rows) {
        const pct = parseFloat(row.dead_pct);
        issues.push({
          id: `perf-bloat-${row.schemaname}-${row.relname}`,
          severity: pct > 30 ? "critical" : "warning",
          category: "performance",
          title: `Table bloat on ${row.relname} (${row.dead_pct}% dead)`,
          description: `${row.schemaname}.${row.relname} has ${Number(row.n_dead_tup).toLocaleString()} dead tuples (${row.dead_pct}% of ${Number(row.n_live_tup).toLocaleString()} live rows). Size: ${row.size}.`,
          fix: `VACUUM FULL ${row.schemaname}.${row.relname};`,
          impact: "Dead tuples waste storage and degrade scan performance.",
          effort: pct > 30 ? "moderate" : "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking table bloat:", (err as Error).message);
    }

    // Cache efficiency per table
    try {
      const r = await client.query(`
        SELECT schemaname, relname,
          heap_blks_hit, heap_blks_read,
          CASE WHEN (heap_blks_hit + heap_blks_read) = 0 THEN 1
            ELSE heap_blks_hit::float / (heap_blks_hit + heap_blks_read) END AS ratio
        FROM pg_statio_user_tables
        WHERE (heap_blks_hit + heap_blks_read) > 100
        ORDER BY ratio ASC LIMIT 5
      `);
      for (const row of r.rows) {
        const ratio = parseFloat(row.ratio);
        if (ratio < 0.9) {
          issues.push({
            id: `perf-cache-${row.schemaname}-${row.relname}`,
            severity: ratio < 0.5 ? "critical" : "warning",
            category: "performance",
            title: `Poor cache hit ratio on ${row.relname}`,
            description: `Table ${row.schemaname}.${row.relname} has a cache hit ratio of ${(ratio * 100).toFixed(1)}%. Most reads are going to disk.`,
            fix: `-- Consider increasing shared_buffers or reducing working set:\nSHOW shared_buffers;`,
            impact: "Disk reads are orders of magnitude slower than memory reads.",
            effort: "involved",
          });
        }
      }
    } catch (err) {
      console.error("[advisor] Error checking cache efficiency:", (err as Error).message);
    }

    // Slow queries from pg_stat_statements
    try {
      const extCheck = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'");
      if (extCheck.rows.length > 0) {
        const r = await client.query(`
          SELECT query, calls, mean_exec_time, total_exec_time,
            round(mean_exec_time::numeric, 2) AS mean_ms,
            round(total_exec_time::numeric / 1000, 2) AS total_sec
          FROM pg_stat_statements
          WHERE query NOT LIKE '%pg_stat%' AND query NOT LIKE '%pg_catalog%'
            AND mean_exec_time > 100
          ORDER BY mean_exec_time DESC LIMIT 5
        `);
        for (const row of r.rows) {
          issues.push({
            id: `perf-slow-${row.query.slice(0, 30).replace(/\W/g, "_")}`,
            severity: parseFloat(row.mean_ms) > 1000 ? "warning" : "info",
            category: "performance",
            title: `Slow query (avg ${row.mean_ms}ms)`,
            description: `Query averaging ${row.mean_ms}ms over ${row.calls} calls (total: ${row.total_sec}s): ${row.query.slice(0, 200)}`,
            fix: `EXPLAIN ANALYZE ${row.query.slice(0, 500)};`,
            impact: "Slow queries degrade overall database responsiveness.",
            effort: "moderate",
          });
        }
      }
    } catch (err) {
      console.error("[advisor] Error checking slow queries:", (err as Error).message);
    }

    // ── Maintenance Advisors ───────────────────────────────────────

    // VACUUM overdue
    try {
      const r = await client.query(`
        SELECT schemaname, relname, last_vacuum, last_autovacuum, n_dead_tup
        FROM pg_stat_user_tables
        WHERE n_live_tup > 100
          AND (last_vacuum IS NULL AND last_autovacuum IS NULL
               OR GREATEST(last_vacuum, last_autovacuum) < now() - interval '7 days')
        ORDER BY n_dead_tup DESC LIMIT 15
      `);
      for (const row of r.rows) {
        const never = !row.last_vacuum && !row.last_autovacuum;
        issues.push({
          id: `maint-vacuum-${row.schemaname}-${row.relname}`,
          severity: never ? "warning" : "info",
          category: "maintenance",
          title: `VACUUM ${never ? "never run" : "overdue"} on ${row.relname}`,
          description: `${row.schemaname}.${row.relname} ${never ? "has never been vacuumed" : "was last vacuumed over 7 days ago"}. Dead tuples: ${Number(row.n_dead_tup).toLocaleString()}.`,
          fix: `VACUUM ANALYZE ${row.schemaname}.${row.relname};`,
          impact: "Dead tuples accumulate, increasing table size and degrading query performance.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking vacuum overdue:", (err as Error).message);
    }

    // ANALYZE overdue
    try {
      const r = await client.query(`
        SELECT schemaname, relname
        FROM pg_stat_user_tables
        WHERE n_live_tup > 100
          AND last_analyze IS NULL AND last_autoanalyze IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_stat_user_tables t2
            WHERE t2.relname = pg_stat_user_tables.relname
              AND (t2.last_vacuum IS NULL AND t2.last_autovacuum IS NULL)
          )
        LIMIT 10
      `);
      for (const row of r.rows) {
        issues.push({
          id: `maint-analyze-${row.schemaname}-${row.relname}`,
          severity: "info",
          category: "maintenance",
          title: `ANALYZE never run on ${row.relname}`,
          description: `${row.schemaname}.${row.relname} has never been analyzed. The query planner may choose suboptimal plans.`,
          fix: `ANALYZE ${row.schemaname}.${row.relname};`,
          impact: "Without statistics, the query planner makes poor estimates leading to slow queries.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking analyze overdue:", (err as Error).message);
    }

    // Transaction ID wraparound risk
    try {
      const r = await client.query(`
        SELECT datname, age(datfrozenxid) AS xid_age
        FROM pg_database
        WHERE datname = current_database()
      `);
      for (const row of r.rows) {
        const age = parseInt(row.xid_age);
        if (age > 1_000_000_000) {
          issues.push({
            id: `maint-xid-wraparound`,
            severity: "critical",
            category: "maintenance",
            title: `Transaction ID wraparound risk`,
            description: `Database ${row.datname} has datfrozenxid age of ${age.toLocaleString()}. Wraparound occurs at ~2 billion.`,
            fix: `VACUUM FREEZE;`,
            impact: "If wraparound occurs, PostgreSQL will shut down to prevent data loss.",
            effort: "involved",
          });
        } else if (age > 500_000_000) {
          issues.push({
            id: `maint-xid-warning`,
            severity: "warning",
            category: "maintenance",
            title: `Transaction ID age is high`,
            description: `Database ${row.datname} has datfrozenxid age of ${age.toLocaleString()}.`,
            fix: `VACUUM FREEZE;`,
            impact: "Approaching transaction ID wraparound threshold.",
            effort: "moderate",
          });
        }
      }
    } catch (err) {
      console.error("[advisor] Error checking xid wraparound:", (err as Error).message);
    }

    // Idle connections > 10 min
    try {
      const r = await client.query(`
        SELECT pid, state, now() - state_change AS idle_duration,
          client_addr::text, application_name,
          extract(epoch from now() - state_change)::int AS idle_seconds
        FROM pg_stat_activity
        WHERE state IN ('idle', 'idle in transaction')
          AND now() - state_change > interval '10 minutes'
          AND pid != pg_backend_pid()
      `);
      for (const row of r.rows) {
        const isIdleTx = row.state === "idle in transaction";
        issues.push({
          id: `maint-idle-${row.pid}`,
          severity: isIdleTx ? "warning" : "info",
          category: "maintenance",
          title: `${isIdleTx ? "Idle in transaction" : "Idle connection"} (PID ${row.pid})`,
          description: `PID ${row.pid} from ${row.client_addr || "local"} (${row.application_name || "unknown"}) has been ${row.state} for ${Math.round(row.idle_seconds / 60)} minutes.`,
          fix: `SELECT pg_terminate_backend(${row.pid});`,
          impact: isIdleTx ? "Idle-in-transaction connections hold locks and prevent VACUUM." : "Idle connections consume connection slots.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking idle connections:", (err as Error).message);
    }

    // ── Schema Advisors ────────────────────────────────────────────

    // Missing primary keys
    try {
      const r = await client.query(`
        SELECT c.relname AS table_name, n.nspname AS schema
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relkind = 'r' AND n.nspname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint con WHERE con.conrelid = c.oid AND con.contype = 'p'
          )
      `);
      for (const row of r.rows) {
        issues.push({
          id: `schema-no-pk-${row.schema}-${row.table_name}`,
          severity: "warning",
          category: "schema",
          title: `Missing primary key on ${row.table_name}`,
          description: `Table ${row.schema}.${row.table_name} has no primary key. This can cause replication issues and makes row identification unreliable.`,
          fix: `ALTER TABLE ${row.schema}.${row.table_name} ADD PRIMARY KEY (<column>);`,
          impact: "No primary key means no unique row identity, problematic for replication and ORMs.",
          effort: "moderate",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking missing primary keys:", (err as Error).message);
    }

    // Unused indexes (idx_scan = 0, size > 1MB)
    try {
      const r = await client.query(`
        SELECT schemaname, relname, indexrelname, idx_scan,
          pg_size_pretty(pg_relation_size(indexrelid)) AS idx_size,
          pg_relation_size(indexrelid) AS idx_bytes
        FROM pg_stat_user_indexes
        WHERE idx_scan = 0
          AND indexrelname NOT LIKE '%_pkey'
          AND pg_relation_size(indexrelid) > 1048576
        ORDER BY pg_relation_size(indexrelid) DESC LIMIT 10
      `);
      for (const row of r.rows) {
        issues.push({
          id: `schema-unused-idx-${row.indexrelname}`,
          severity: "warning",
          category: "schema",
          title: `Unused index ${row.indexrelname} (${row.idx_size})`,
          description: `Index ${row.indexrelname} on ${row.relname} has never been used (0 scans) and takes ${row.idx_size}.`,
          fix: `DROP INDEX CONCURRENTLY ${row.schemaname}.${row.indexrelname};`,
          impact: "Unused indexes waste disk space and slow down writes.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking unused indexes:", (err as Error).message);
    }

    // Duplicate indexes
    try {
      const r = await client.query(`
        SELECT array_agg(idx.indexrelid::regclass::text) AS indexes,
          idx.indrelid::regclass::text AS table_name,
          pg_size_pretty(sum(pg_relation_size(idx.indexrelid))) AS total_size
        FROM pg_index idx
        GROUP BY idx.indrelid, idx.indkey
        HAVING count(*) > 1
      `);
      for (const row of r.rows) {
        issues.push({
          id: `schema-dup-idx-${row.table_name}-${row.indexes[0]}`,
          severity: "warning",
          category: "schema",
          title: `Duplicate indexes on ${row.table_name}`,
          description: `These indexes cover the same columns on ${row.table_name}: ${row.indexes.join(", ")}. Total wasted space: ${row.total_size}.`,
          fix: `-- Keep one, drop the rest:\nDROP INDEX CONCURRENTLY ${row.indexes.slice(1).join(";\nDROP INDEX CONCURRENTLY ")};`,
          impact: "Duplicate indexes double the write overhead and waste disk space.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking duplicate indexes:", (err as Error).message);
    }

    // Missing foreign key indexes
    try {
      const r = await client.query(`
        SELECT
          conrelid::regclass::text AS table_name,
          a.attname AS column_name,
          confrelid::regclass::text AS referenced_table
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f'
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND a.attnum = ANY(i.indkey)
          )
      `);
      for (const row of r.rows) {
        issues.push({
          id: `schema-fk-no-idx-${row.table_name}-${row.column_name}`,
          severity: "warning",
          category: "schema",
          title: `Missing index on FK column ${row.table_name}.${row.column_name}`,
          description: `Foreign key column ${row.column_name} on ${row.table_name} (references ${row.referenced_table}) has no index. This causes slow JOINs and cascading deletes.`,
          fix: `CREATE INDEX CONCURRENTLY idx_${row.table_name.replace(/\./g, "_")}_${row.column_name} ON ${row.table_name} (${row.column_name});`,
          impact: "JOINs and cascading deletes on this FK will require full table scans.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking missing FK indexes:", (err as Error).message);
    }

    // ── Infrastructure Advisors ──────────────────────────────────────

    // Lock detection
    try {
      const r = await client.query(`
        SELECT blocked_locks.pid AS blocked_pid,
          blocking_locks.pid AS blocking_pid,
          blocked_activity.query AS blocked_query
        FROM pg_catalog.pg_locks blocked_locks
        JOIN pg_catalog.pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
          AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
          AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
          AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
          AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
          AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
          AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
          AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
          AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
          AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
          AND blocking_locks.pid != blocked_locks.pid
        JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
        WHERE NOT blocked_locks.granted
      `);
      for (const row of r.rows) {
        issues.push({
          id: `perf-lock-blocked-${row.blocked_pid}`,
          severity: "warning",
          category: "performance",
          title: `Blocked query (PID ${row.blocked_pid} blocked by PID ${row.blocking_pid})`,
          description: `PID ${row.blocked_pid} is waiting for a lock held by PID ${row.blocking_pid}. Query: ${(row.blocked_query || "").slice(0, 200)}`,
          fix: `SELECT pg_cancel_backend(${row.blocking_pid});`,
          impact: "Blocked queries cause cascading delays and potential timeouts.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking locks:", (err as Error).message);
    }

    // WAL/replication lag
    try {
      const r = await client.query(`
        SELECT CASE WHEN pg_is_in_recovery()
          THEN pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())
          ELSE 0 END AS lag_bytes
      `);
      const lagBytes = parseInt(r.rows[0]?.lag_bytes ?? "0");
      if (lagBytes > 1048576) { // > 1MB
        issues.push({
          id: `perf-replication-lag`,
          severity: lagBytes > 104857600 ? "critical" : "warning",
          category: "performance",
          title: `Replication lag: ${(lagBytes / 1048576).toFixed(1)} MB`,
          description: `WAL replay is lagging by ${(lagBytes / 1048576).toFixed(1)} MB. This indicates the replica is falling behind.`,
          fix: `-- Check replication status:\nSELECT * FROM pg_stat_replication;`,
          impact: "High replication lag means the replica has stale data and failover may lose transactions.",
          effort: "involved",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking replication lag:", (err as Error).message);
    }

    // Checkpoint frequency
    try {
      const r = await client.query(`
        SELECT checkpoints_req, checkpoints_timed,
          CASE WHEN (checkpoints_req + checkpoints_timed) = 0 THEN 0
            ELSE round(checkpoints_req::numeric / (checkpoints_req + checkpoints_timed) * 100, 1) END AS req_pct
        FROM pg_stat_bgwriter
      `);
      const reqPct = parseFloat(r.rows[0]?.req_pct ?? "0");
      if (reqPct > 50) {
        issues.push({
          id: `maint-checkpoint-frequency`,
          severity: reqPct > 80 ? "warning" : "info",
          category: "maintenance",
          title: `${reqPct}% of checkpoints are requested (not timed)`,
          description: `${r.rows[0]?.checkpoints_req} requested vs ${r.rows[0]?.checkpoints_timed} timed checkpoints. High requested checkpoints indicate checkpoint_completion_target or max_wal_size may need tuning.`,
          fix: `-- Increase max_wal_size:\nALTER SYSTEM SET max_wal_size = '2GB';\nSELECT pg_reload_conf();`,
          impact: "Frequent requested checkpoints cause I/O spikes and degrade performance.",
          effort: "moderate",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking checkpoint frequency:", (err as Error).message);
    }

    // AutoVACUUM config check
    try {
      const r = await client.query(`SELECT setting FROM pg_settings WHERE name = 'autovacuum'`);
      if (r.rows[0]?.setting === "off") {
        issues.push({
          id: `maint-autovacuum-disabled`,
          severity: "critical",
          category: "maintenance",
          title: `Autovacuum is disabled`,
          description: `Autovacuum is turned off. Dead tuples will accumulate and transaction ID wraparound becomes a risk.`,
          fix: `ALTER SYSTEM SET autovacuum = on;\nSELECT pg_reload_conf();`,
          impact: "Without autovacuum, tables bloat indefinitely and risk transaction ID wraparound shutdown.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking autovacuum:", (err as Error).message);
    }

    // shared_buffers / work_mem check
    try {
      const sbRes = await client.query(`SELECT setting, unit FROM pg_settings WHERE name = 'shared_buffers'`);
      const memRes = await client.query(`
        SELECT (SELECT setting::bigint FROM pg_settings WHERE name = 'shared_buffers') *
               (SELECT setting::bigint FROM pg_settings WHERE name = 'block_size') AS shared_bytes
      `);
      const sharedBytes = parseInt(memRes.rows[0]?.shared_bytes ?? "0");
      // Get total RAM from OS via a simple query (pg doesn't expose this directly, but we can estimate)
      // We'll compare against a reasonable minimum: if shared_buffers < 128MB, warn
      if (sharedBytes > 0 && sharedBytes < 128 * 1024 * 1024) {
        issues.push({
          id: `perf-shared-buffers-low`,
          severity: "warning",
          category: "performance",
          title: `shared_buffers is only ${(sharedBytes / 1048576).toFixed(0)} MB`,
          description: `shared_buffers is set to ${sbRes.rows[0]?.setting}${sbRes.rows[0]?.unit || ""}. Recommended: ~25% of system RAM, typically at least 256MB for production.`,
          fix: `ALTER SYSTEM SET shared_buffers = '256MB';\n-- Requires restart`,
          impact: "Low shared_buffers means more disk I/O and poor cache hit ratios.",
          effort: "involved",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking shared_buffers:", (err as Error).message);
    }

    try {
      const r = await client.query(`SELECT setting, unit FROM pg_settings WHERE name = 'work_mem'`);
      const workMemKB = parseInt(r.rows[0]?.setting ?? "0");
      if (workMemKB > 0 && workMemKB < 4096) { // < 4MB
        issues.push({
          id: `perf-work-mem-low`,
          severity: "info",
          category: "performance",
          title: `work_mem is only ${workMemKB < 1024 ? workMemKB + "kB" : (workMemKB / 1024).toFixed(0) + "MB"}`,
          description: `work_mem is ${r.rows[0]?.setting}${r.rows[0]?.unit || ""}. Low work_mem causes sorts and hash operations to spill to disk.`,
          fix: `ALTER SYSTEM SET work_mem = '16MB';\nSELECT pg_reload_conf();`,
          impact: "Operations that exceed work_mem use temporary disk files, which is much slower.",
          effort: "quick",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking work_mem:", (err as Error).message);
    }

    // ── Security Advisors ──────────────────────────────────────────

    // Superuser connections from non-localhost
    try {
      const r = await client.query(`
        SELECT pid, usename, client_addr::text
        FROM pg_stat_activity
        WHERE usename IN (SELECT rolname FROM pg_roles WHERE rolsuper)
          AND client_addr IS NOT NULL
          AND client_addr::text NOT IN ('127.0.0.1', '::1')
          AND pid != pg_backend_pid()
      `);
      for (const row of r.rows) {
        issues.push({
          id: `sec-superuser-remote-${row.pid}`,
          severity: "critical",
          category: "security",
          title: `Superuser ${row.usename} connected from ${row.client_addr}`,
          description: `Superuser ${row.usename} has an active connection from non-localhost address ${row.client_addr}. This is a security risk.`,
          fix: `-- Restrict superuser access in pg_hba.conf to localhost only.\n-- Then: SELECT pg_reload_conf();`,
          impact: "Remote superuser access is a significant security vulnerability.",
          effort: "moderate",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking superuser connections:", (err as Error).message);
    }

    // SSL disabled
    try {
      const r = await client.query(`SELECT setting FROM pg_settings WHERE name = 'ssl'`);
      if (r.rows[0]?.setting === "off") {
        issues.push({
          id: `sec-ssl-off`,
          severity: "warning",
          category: "security",
          title: `SSL is disabled`,
          description: `SSL is turned off. Database connections are not encrypted.`,
          fix: `-- Enable SSL in postgresql.conf:\n-- ssl = on\n-- ssl_cert_file = 'server.crt'\n-- ssl_key_file = 'server.key'\nSELECT pg_reload_conf();`,
          impact: "Database traffic can be intercepted and read in transit.",
          effort: "involved",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking SSL check:", (err as Error).message);
    }

    // Password authentication check (PG 15+)
    try {
      const r = await client.query(`
        SELECT type, database, user_name, auth_method
        FROM pg_hba_file_rules
        WHERE auth_method = 'trust' AND type != 'local'
        LIMIT 5
      `);
      for (const row of r.rows) {
        issues.push({
          id: `sec-trust-auth-${row.database}-${row.user_name}`,
          severity: "critical",
          category: "security",
          title: `Trust authentication for ${row.user_name}@${row.database}`,
          description: `HBA rule allows trust (no password) authentication for ${row.type} connections to ${row.database} as ${row.user_name}.`,
          fix: `-- Change auth_method from 'trust' to 'scram-sha-256' in pg_hba.conf\n-- Then: SELECT pg_reload_conf();`,
          impact: "Anyone can connect without a password.",
          effort: "moderate",
        });
      }
    } catch (err) {
      console.error("[advisor] Error checking trust auth:", (err as Error).message);
    } // pg_hba_file_rules not available pre-PG15

    const score = computeAdvisorScore(issues);
    return {
      score,
      grade: gradeFromScore(score),
      issues,
      breakdown: computeBreakdown(issues),
    };
  } finally {
    client.release();
  }
}

// Allowed SQL operations for the fix endpoint

export function isSafeFix(sql: string): boolean {
  const trimmed = sql.trim();
  if (!trimmed) return false;

  // Reject multi-statement SQL (split on semicolons, ignore trailing)
  const statements = trimmed.replace(/;\s*$/, "").split(";").map(s => s.trim()).filter(Boolean);
  if (statements.length !== 1) return false;

  const upper = statements[0].toUpperCase();

  // EXPLAIN ANALYZE — only allow if followed by SELECT
  if (upper.startsWith("EXPLAIN ANALYZE")) {
    const afterExplain = upper.replace(/^EXPLAIN\s+ANALYZE\s+/, "").trimStart();
    return afterExplain.startsWith("SELECT");
  }

  // Simple prefix allowlist for single statements
  const ALLOWED_PREFIXES = [
    "VACUUM",
    "ANALYZE",
    "REINDEX",
    "CREATE INDEX CONCURRENTLY",
    "DROP INDEX CONCURRENTLY",
    "SELECT PG_TERMINATE_BACKEND(",
    "SELECT PG_CANCEL_BACKEND(",
  ];

  return ALLOWED_PREFIXES.some((p) => upper.startsWith(p));
}
