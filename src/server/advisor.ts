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
          pg_relation_size(indrelid) AS tbl_size,
          pg_size_pretty(pg_relation_size(indexrelid)) AS idx_size_pretty,
          pg_size_pretty(pg_relation_size(indrelid)) AS tbl_size_pretty
        FROM pg_stat_user_indexes
        WHERE pg_relation_size(indexrelid) > 1048576
          AND pg_relation_size(indexrelid) > pg_relation_size(indrelid) * 3
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
const ALLOWED_PREFIXES = [
  "VACUUM",
  "ANALYZE",
  "REINDEX",
  "CREATE INDEX CONCURRENTLY",
  "DROP INDEX CONCURRENTLY",
  "SELECT pg_terminate_backend(",
  "SELECT pg_cancel_backend(",
  "EXPLAIN ANALYZE",
];

export function isSafeFix(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return ALLOWED_PREFIXES.some((p) => trimmed.startsWith(p.toUpperCase()));
}
