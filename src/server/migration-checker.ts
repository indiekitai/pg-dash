// Migration safety checker — static + dynamic analysis of SQL migration files

import type { Pool } from "pg";

export interface MigrationIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  suggestion?: string;
  lineNumber?: number;
  tableName?: string;
  estimatedRows?: number;
  estimatedLockSeconds?: number;
}

export interface MigrationCheckResult {
  safe: boolean;
  issues: MigrationIssue[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
  };
  checkedAt: string;
}

// Helper: find line number of a match in the original SQL
function findLineNumber(sql: string, matchIndex: number): number {
  const before = sql.slice(0, matchIndex);
  return before.split("\n").length;
}

// Extract bare table name from possibly-quoted or schema-qualified identifier
function bareTable(name: string): string {
  return name
    .replace(/^public\./i, "")
    .replace(/"/g, "")
    .toLowerCase()
    .trim();
}

// Parse all table names operated on by this migration
function extractOperatedTables(sql: string): {
  indexTables: string[];    // CREATE INDEX ON <table>
  alterTables: string[];    // ALTER TABLE <table>
  dropTables: string[];     // DROP TABLE <table>
  refTables: string[];      // REFERENCES <table>
} {
  const indexTables: string[] = [];
  const alterTables: string[] = [];
  const dropTables: string[] = [];
  const refTables: string[] = [];

  // CREATE INDEX ... ON table
  const idxRe = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\s+)?ON\s+([\w."]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = idxRe.exec(sql)) !== null) indexTables.push(bareTable(m[1]));

  // ALTER TABLE table
  const altRe = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."]+)/gi;
  while ((m = altRe.exec(sql)) !== null) alterTables.push(bareTable(m[1]));

  // DROP TABLE
  const dropRe = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."]+)/gi;
  while ((m = dropRe.exec(sql)) !== null) dropTables.push(bareTable(m[1]));

  // REFERENCES table
  const refRe = /\bREFERENCES\s+([\w."]+)/gi;
  while ((m = refRe.exec(sql)) !== null) refTables.push(bareTable(m[1]));

  return { indexTables, alterTables, dropTables, refTables };
}

// Static analysis — no DB needed
function staticCheck(sql: string): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const upper = sql.toUpperCase();

  // Determine tables created IN THIS MIGRATION (so we know they're brand-new)
  const createdTablesRe = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi;
  const createdTables = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = createdTablesRe.exec(sql)) !== null) createdTables.add(bareTable(m[1]));

  // 1. CREATE INDEX without CONCURRENTLY (on tables NOT created in this migration)
  const idxRe = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)((?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\s+)?ON\s+([\w."]+))/gi;
  while ((m = idxRe.exec(sql)) !== null) {
    const table = bareTable(m[2]);
    const lineNumber = findLineNumber(sql, m.index);
    if (!createdTables.has(table)) {
      issues.push({
        severity: "warning",
        code: "INDEX_WITHOUT_CONCURRENTLY",
        message: `CREATE INDEX on existing table will lock writes. Use CREATE INDEX CONCURRENTLY to avoid downtime.`,
        suggestion: "Replace CREATE INDEX with CREATE INDEX CONCURRENTLY",
        lineNumber,
        tableName: table,
      });
    }
  }

  // 2. CREATE INDEX CONCURRENTLY → info
  const idxConcRe = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/gi;
  while ((m = idxConcRe.exec(sql)) !== null) {
    issues.push({
      severity: "info",
      code: "INDEX_CONCURRENTLY_OK",
      message: "CREATE INDEX CONCURRENTLY — safe, no write lock",
      lineNumber: findLineNumber(sql, m.index),
    });
  }

  // 3 & 4. ALTER TABLE ... ADD COLUMN ... NOT NULL (with/without DEFAULT)
  // Match: ALTER TABLE <t> ADD COLUMN <col> <type> [DEFAULT <val>] [NOT NULL | NULL]
  const addColRe =
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."]+)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[\w"]+\s+[\w\s()"',.[\]]+?(?=;|$)/gi;
  while ((m = addColRe.exec(sql)) !== null) {
    const fragment = m[0];
    const table = bareTable(m[1]);
    const lineNumber = findLineNumber(sql, m.index);
    const fragUpper = fragment.toUpperCase();

    const hasNotNull = /\bNOT\s+NULL\b/.test(fragUpper);
    const hasDefault = /\bDEFAULT\b/.test(fragUpper);

    if (hasNotNull && !hasDefault) {
      issues.push({
        severity: "error",
        code: "ADD_COLUMN_NOT_NULL_NO_DEFAULT",
        message: "ADD COLUMN NOT NULL without DEFAULT will fail if table has existing rows",
        suggestion: "Add a DEFAULT value, then remove it after migration",
        lineNumber,
        tableName: table,
      });
    } else if (hasNotNull && hasDefault) {
      issues.push({
        severity: "warning",
        code: "ADD_COLUMN_REWRITES_TABLE",
        message: "ADD COLUMN with NOT NULL DEFAULT may rewrite table on PostgreSQL < 11",
        suggestion: "On PostgreSQL 11+ with a constant default this is safe. For older versions, add column nullable first.",
        lineNumber,
        tableName: table,
      });
    }
  }

  // 5. DROP TABLE
  const dropRe = /\bDROP\s+TABLE\b/gi;
  while ((m = dropRe.exec(sql)) !== null) {
    issues.push({
      severity: "warning",
      code: "DROP_TABLE",
      message: "DROP TABLE is destructive. Ensure this is intentional and data is backed up.",
      lineNumber: findLineNumber(sql, m.index),
    });
  }

  // 6. TRUNCATE
  const truncRe = /\bTRUNCATE\b/gi;
  while ((m = truncRe.exec(sql)) !== null) {
    issues.push({
      severity: "warning",
      code: "TRUNCATE_TABLE",
      message: "TRUNCATE will delete all rows. Ensure this is intentional.",
      lineNumber: findLineNumber(sql, m.index),
    });
  }

  // 7. DELETE FROM without WHERE
  const delRe = /\bDELETE\s+FROM\s+[\w."]+\s*(?:;|$)/gi;
  while ((m = delRe.exec(sql)) !== null) {
    // If there's no WHERE clause in this statement
    const stmt = m[0];
    if (!/\bWHERE\b/i.test(stmt)) {
      issues.push({
        severity: "warning",
        code: "DELETE_WITHOUT_WHERE",
        message: "DELETE without WHERE clause will remove all rows.",
        lineNumber: findLineNumber(sql, m.index),
      });
    }
  }

  // 8. UPDATE ... SET without WHERE
  const updRe = /\bUPDATE\s+[\w."]+\s+SET\b[^;]*(;|$)/gi;
  while ((m = updRe.exec(sql)) !== null) {
    const stmt = m[0];
    if (!/\bWHERE\b/i.test(stmt)) {
      issues.push({
        severity: "warning",
        code: "UPDATE_WITHOUT_WHERE",
        message: "UPDATE without WHERE clause will modify all rows.",
        lineNumber: findLineNumber(sql, m.index),
      });
    }
  }

  return issues;
}

// Dynamic analysis — requires a running PG pool
async function dynamicCheck(sql: string, pool: Pool, staticIssues: MigrationIssue[]): Promise<MigrationIssue[]> {
  const issues: MigrationIssue[] = [];
  const { indexTables, alterTables, dropTables, refTables } = extractOperatedTables(sql);

  // All tables we need to look up
  const allTables = [...new Set([...indexTables, ...alterTables, ...dropTables])];

  // Query row counts for all tables at once
  const tableStats = new Map<string, { rowCount: number; totalSize: number }>();
  if (allTables.length > 0) {
    try {
      const res = await pool.query<{ tablename: string; n_live_tup: string; total_size: string }>(
        `SELECT tablename,
                n_live_tup,
                pg_total_relation_size(schemaname||'.'||tablename) AS total_size
         FROM pg_stat_user_tables
         WHERE tablename = ANY($1)`,
        [allTables]
      );
      for (const row of res.rows) {
        tableStats.set(row.tablename, {
          rowCount: parseInt(row.n_live_tup ?? "0", 10),
          totalSize: parseInt(row.total_size ?? "0", 10),
        });
      }
    } catch (_) {
      // Ignore DB errors in dynamic check
    }
  }

  // Upgrade CREATE INDEX (non-CONCURRENTLY) issues based on actual row counts
  for (const issue of staticIssues) {
    if (issue.code === "INDEX_WITHOUT_CONCURRENTLY" && issue.tableName) {
      const stats = tableStats.get(issue.tableName);
      if (stats) {
        const { rowCount } = stats;
        const lockSecs = Math.round(rowCount / 50000);
        issue.estimatedRows = rowCount;
        issue.estimatedLockSeconds = lockSecs;

        if (rowCount > 1_000_000) {
          issue.severity = "error";
          issue.message = `CREATE INDEX on '${issue.tableName}' will lock writes for ~${lockSecs}s (${(rowCount / 1e6).toFixed(1)}M rows). CRITICAL — use CREATE INDEX CONCURRENTLY.`;
        } else if (rowCount > 100_000) {
          issue.message = `CREATE INDEX on '${issue.tableName}' will lock writes for ~${lockSecs}s (${(rowCount / 1000).toFixed(0)}k rows).`;
        }
      }
    }
  }

  // Validate REFERENCES tables exist
  const uniqueRefTables = [...new Set(refTables)];
  for (const table of uniqueRefTables) {
    try {
      const res = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
        [table]
      );
      if (res.rows.length === 0) {
        issues.push({
          severity: "error",
          code: "MISSING_TABLE",
          message: `Table '${table}' referenced in migration does not exist`,
          tableName: table,
        });
      }
    } catch (_) {
      // Ignore
    }
  }

  return issues;
}

export async function analyzeMigration(sql: string, pool?: Pool): Promise<MigrationCheckResult> {
  const trimmed = sql.trim();

  if (!trimmed) {
    return {
      safe: true,
      issues: [],
      summary: { errors: 0, warnings: 0, infos: 0 },
      checkedAt: new Date().toISOString(),
    };
  }

  // Static checks first (mutates issue severity if dynamic info is available)
  const issues = staticCheck(trimmed);

  // Dynamic checks (augments existing issues + adds new ones like MISSING_TABLE)
  if (pool) {
    const dynamicIssues = await dynamicCheck(trimmed, pool, issues);
    issues.push(...dynamicIssues);
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;

  return {
    safe: errors === 0,
    issues,
    summary: { errors, warnings, infos },
    checkedAt: new Date().toISOString(),
  };
}
