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

// Strip SQL comments while preserving line numbers (replace with spaces)
function stripComments(sql: string): string {
  // Replace /* ... */ block comments (preserve newlines for line number tracking)
  let stripped = sql.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " ")
  );
  // Replace -- single-line comments (preserve the newline)
  stripped = stripped.replace(/--[^\n]*/g, (match) => " ".repeat(match.length));
  return stripped;
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
  sql = stripComments(sql);
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
  // Strip comments before analysis to avoid false positives from commented-out SQL
  sql = stripComments(sql);

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

  // 5b. ALTER COLUMN TYPE — rewrites the entire table and locks it
  const alterTypeRe = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."]+)\s+ALTER\s+(?:COLUMN\s+)?[\w"]+\s+TYPE\b/gi;
  while ((m = alterTypeRe.exec(sql)) !== null) {
    const table = bareTable(m[1]);
    issues.push({
      severity: "warning",
      code: "ALTER_COLUMN_TYPE",
      message: "ALTER COLUMN TYPE rewrites the entire table and acquires an exclusive lock.",
      suggestion: "Consider using a new column + backfill + rename strategy to avoid downtime.",
      lineNumber: findLineNumber(sql, m.index),
      tableName: table,
    });
  }

  // 5c. DROP COLUMN — safe in PostgreSQL 9.0+ (marks invisible, no rewrite), but breaks app code
  const dropColRe = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."]+)\s+DROP\s+(?:COLUMN\s+)(?:IF\s+EXISTS\s+)?[\w"]+\b/gi;
  while ((m = dropColRe.exec(sql)) !== null) {
    const table = bareTable(m[1]);
    issues.push({
      severity: "info",
      code: "DROP_COLUMN",
      message: "DROP COLUMN is safe in PostgreSQL (no table rewrite), but may break application code referencing that column.",
      suggestion: "Ensure no application code references this column before dropping it.",
      lineNumber: findLineNumber(sql, m.index),
      tableName: table,
    });
  }

  // 5d-i. RENAME TABLE
  const renameTableRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)\s+RENAME\s+TO\s+(\w+)/gi;
  while ((m = renameTableRe.exec(sql)) !== null) {
    const oldName = m[1];
    const newName = m[2];
    issues.push({
      severity: "warning",
      code: "RENAME_TABLE",
      message: `Renaming table "${oldName}" to "${newName}" breaks application code referencing the old name`,
      suggestion: "Deploy application code that handles both names before renaming, or use a view with the old name after renaming.",
      lineNumber: findLineNumber(sql, m.index),
      tableName: oldName,
    });
  }

  // 5d-ii. RENAME COLUMN
  const renameColumnRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)\s+RENAME\s+COLUMN\s+(\w+)\s+TO\s+(\w+)/gi;
  while ((m = renameColumnRe.exec(sql)) !== null) {
    const table = m[1];
    const oldCol = m[2];
    const newCol = m[3];
    issues.push({
      severity: "warning",
      code: "RENAME_COLUMN",
      message: `Renaming column "${oldCol}" to "${newCol}" on table "${table}" breaks application code referencing the old column name`,
      suggestion: "Add new column, backfill data, update application to use new column, then drop old column (expand/contract pattern).",
      lineNumber: findLineNumber(sql, m.index),
      tableName: table,
    });
  }

  // 5e. ADD CONSTRAINT without NOT VALID — performs a full table scan to validate
  const addConRe = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."]+)\s+ADD\s+CONSTRAINT\b[^;]*(;|$)/gi;
  while ((m = addConRe.exec(sql)) !== null) {
    const fragment = m[0];
    const table = bareTable(m[1]);
    const fragUpper = fragment.toUpperCase();
    // Skip if NOT VALID is already present
    if (!/\bNOT\s+VALID\b/.test(fragUpper)) {
      issues.push({
        severity: "warning",
        code: "ADD_CONSTRAINT_SCANS_TABLE",
        message: "ADD CONSTRAINT validates all existing rows and holds an exclusive lock during the scan.",
        suggestion: "Use ADD CONSTRAINT ... NOT VALID to skip validation, then VALIDATE CONSTRAINT in a separate transaction.",
        lineNumber: findLineNumber(sql, m.index),
        tableName: table,
      });
    }
  }

  // 5e. CREATE INDEX CONCURRENTLY inside transaction (BEGIN/COMMIT)
  const hasTransaction = /\bBEGIN\b/i.test(sql) || /\bSTART\s+TRANSACTION\b/i.test(sql);
  const hasConcurrently = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(sql);
  if (hasTransaction && hasConcurrently) {
    issues.push({
      severity: "error",
      code: "CONCURRENTLY_IN_TRANSACTION",
      message: "CREATE INDEX CONCURRENTLY cannot run inside a transaction block. It will fail at runtime.",
      suggestion: "Remove the BEGIN/COMMIT wrapper, or use a migration tool that runs CONCURRENTLY outside transactions.",
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
