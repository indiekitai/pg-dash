// query-analyzer.ts — deep EXPLAIN plan analysis with auto index suggestions

import type { Pool } from "pg";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlanNodeSummary {
  nodeType: string;
  table?: string;
  totalCost: number;
  actualRows?: number;
  actualTime?: number; // ms
  filter?: string;
}

export interface SeqScanInfo {
  table: string;
  rowCount: number;
  filter?: string; // filter condition from explain output
  suggestion?: string;
}

export interface IndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  sql: string; // CREATE INDEX CONCURRENTLY …
  estimatedBenefit: "high" | "medium" | "low";
}

export interface ExplainAnalysis {
  planNodes: PlanNodeSummary[];
  seqScans: SeqScanInfo[];
  missingIndexes: IndexSuggestion[];
  costEstimate: {
    totalCost: number;
    actualTime?: number;
    planningTime?: number;
  };
  recommendations: string[];
}

export interface QueryRegressionInfo {
  queryId: string; // queryid from pg_stat_statements
  currentMeanMs: number;
  previousMeanMs: number;
  changePercent: number;
  degradedAt?: string; // approximate timestamp
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursively walk a plan tree (EXPLAIN FORMAT JSON) and collect every node.
 * Each node looks like { "Node Type": "...", "Plans": [...], ... }
 */
function collectNodes(node: any, acc: any[] = []): any[] {
  if (!node || typeof node !== "object") return acc;
  acc.push(node);
  const plans = node["Plans"] ?? node["plans"];
  if (Array.isArray(plans)) {
    for (const child of plans) collectNodes(child, acc);
  }
  return acc;
}

/**
 * Extract simple column names from a Postgres filter expression.
 * Handles patterns like:
 *   (col = $1)
 *   (col > $1)
 *   (col IS NULL)
 *   (col IS NOT NULL)
 *   (col ~~ '%foo%')   -- LIKE
 */
function extractColumnsFromFilter(filter: string): string[] {
  // Match identifiers that appear before comparison operators
  const colPattern = /\(?"?([a-z_][a-z0-9_]*)"?\s*(?:=|<|>|<=|>=|<>|!=|IS\s+(?:NOT\s+)?NULL|~~|!~~)/gi;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = colPattern.exec(filter)) !== null) {
    const col = m[1].toLowerCase();
    // Skip Postgres internal names
    if (!["and", "or", "not", "true", "false", "null"].includes(col)) {
      found.add(col);
    }
  }
  return Array.from(found);
}

/**
 * Fetch the list of indexed column sets for a given table from pg_indexes.
 * Returns an array of column name arrays (one per index).
 */
async function getExistingIndexColumns(pool: Pool, tableName: string): Promise<string[][]> {
  try {
    // Query pg_indexes to get index definitions
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = $1`,
      [tableName]
    );
    return r.rows.map((row: any) => {
      // Parse column list from: ... ON table (col1, col2, ...)
      const m = /\(([^)]+)\)/.exec(row.indexdef);
      if (!m) return [] as string[];
      return m[1]
        .split(",")
        .map((c: string) => c.trim().replace(/^"|"$/g, "").toLowerCase());
    });
  } catch {
    return [];
  }
}

/**
 * Benefit rating based on estimated row count.
 */
function rateBenefit(rowCount: number): "high" | "medium" | "low" {
  if (rowCount > 100_000) return "high";
  if (rowCount >= 10_000) return "medium";
  return "low";
}

/**
 * Format a large number as human-readable (1.2M, 50K, etc.)
 */
function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ─── Core analysis ────────────────────────────────────────────────────────────

/**
 * Analyse a EXPLAIN (FORMAT JSON) result and return rich diagnostics.
 *
 * @param explainJson  - The value of `r.rows[0]["QUERY PLAN"]` (an array with one plan object)
 * @param pool         - Optional PG pool; without it only static analysis is performed
 */
export async function analyzeExplainPlan(
  explainJson: any,
  pool?: Pool | null
): Promise<ExplainAnalysis> {
  const result: ExplainAnalysis = {
    planNodes: [],
    seqScans: [],
    missingIndexes: [],
    costEstimate: { totalCost: 0 },
    recommendations: [],
  };

  if (!explainJson || !Array.isArray(explainJson) || explainJson.length === 0) {
    return result;
  }

  const topLevel = explainJson[0];
  const planRoot = topLevel?.["Plan"] ?? topLevel?.["plan"];

  // Planning / execution times from top-level
  const planningTime: number | undefined = topLevel?.["Planning Time"] ?? undefined;
  const executionTime: number | undefined = topLevel?.["Execution Time"] ?? undefined;

  if (!planRoot) return result;

  // Collect all nodes
  const allNodes = collectNodes(planRoot);

  // Build planNodes summary
  result.planNodes = allNodes.map((n: any) => {
    const s: PlanNodeSummary = {
      nodeType: n["Node Type"] ?? "Unknown",
      totalCost: n["Total Cost"] ?? 0,
    };
    if (n["Relation Name"]) s.table = n["Relation Name"];
    if (n["Actual Rows"] !== undefined) s.actualRows = n["Actual Rows"];
    if (n["Actual Total Time"] !== undefined) s.actualTime = n["Actual Total Time"];
    if (n["Filter"]) s.filter = n["Filter"];
    return s;
  });

  // Cost estimate from root node
  result.costEstimate = {
    totalCost: planRoot["Total Cost"] ?? 0,
    actualTime: executionTime,
    planningTime,
  };

  // ── Seq Scan analysis ──────────────────────────────────────────────────────
  const seqScanNodes = allNodes.filter((n: any) => n["Node Type"] === "Seq Scan");

  for (const node of seqScanNodes) {
    const table: string = node["Relation Name"] ?? "unknown";
    const rowCount: number = node["Plan Rows"] ?? node["Actual Rows"] ?? 0;
    const filter: string | undefined = node["Filter"];

    const info: SeqScanInfo = { table, rowCount, filter };

    if (rowCount > 10_000) {
      info.suggestion = filter
        ? `Consider adding an index to support the filter on ${table}`
        : `Full table scan on large table ${table} — review query`;
    }

    result.seqScans.push(info);
  }

  // ── Missing index inference ────────────────────────────────────────────────
  for (const scan of result.seqScans) {
    if (!scan.filter) continue;

    const cols = extractColumnsFromFilter(scan.filter);
    if (cols.length === 0) continue;

    // Check existing indexes (needs DB)
    let existingIndexCols: string[][] = [];
    if (pool) {
      existingIndexCols = await getExistingIndexColumns(pool, scan.table);
    }

    // Filter out columns already covered as the leading column of an existing index
    const uncoveredCols = cols.filter(
      (col) => !existingIndexCols.some((idxCols) => idxCols.length > 0 && idxCols[0] === col)
    );

    if (uncoveredCols.length === 0) continue;

    const benefit = rateBenefit(scan.rowCount);

    if (uncoveredCols.length >= 2) {
      // Suggest a composite index
      const idxName = `idx_${scan.table}_${uncoveredCols.join("_")}`;
      const sql = `CREATE INDEX CONCURRENTLY ${idxName} ON ${scan.table} (${uncoveredCols.join(", ")})`;
      result.missingIndexes.push({
        table: scan.table,
        columns: uncoveredCols,
        reason: `Seq Scan with multi-column filter (${uncoveredCols.join(", ")}) on ${fmtRows(scan.rowCount)} rows — composite index preferred`,
        sql,
        estimatedBenefit: benefit,
      });
    } else {
      // Single column
      const col = uncoveredCols[0];
      const idxName = `idx_${scan.table}_${col}`;
      const sql = `CREATE INDEX CONCURRENTLY ${idxName} ON ${scan.table} (${col})`;
      result.missingIndexes.push({
        table: scan.table,
        columns: [col],
        reason: `Seq Scan with Filter on ${col} (${fmtRows(scan.rowCount)} rows)`,
        sql,
        estimatedBenefit: benefit,
      });
    }
  }

  // ── Recommendations ────────────────────────────────────────────────────────
  for (const scan of result.seqScans) {
    if (scan.rowCount > 10_000) {
      const filterPart = scan.filter
        ? ` — consider adding index on ${extractColumnsFromFilter(scan.filter).join(", ") || "filter columns"}`
        : " — no filter; full scan may be intentional";
      result.recommendations.push(
        `Seq Scan on ${scan.table} (${fmtRows(scan.rowCount)} rows)${filterPart}`
      );
    }
  }

  if (planningTime !== undefined) {
    const label = planningTime > 10 ? "high — check statistics" : "normal";
    result.recommendations.push(`Planning time ${planningTime.toFixed(1)}ms — ${label}`);
  }

  if (result.missingIndexes.length === 0 && result.seqScans.length === 0) {
    result.recommendations.push("No obvious sequential scans detected — query looks efficient");
  }

  return result;
}

// ─── Regression detection ─────────────────────────────────────────────────────

/**
 * Detect queries whose mean execution time has increased by more than 50%
 * compared to the earliest snapshot in the query_stats store for the given window.
 *
 * This is a best-effort function; it silently returns [] if pg_stat_statements
 * is unavailable or the query_stats store doesn't have enough history.
 *
 * @param pool         - PG pool (used to read pg_stat_statements)
 * @param statsDb      - Optional better-sqlite3 Database with query_stats table
 * @param windowHours  - How far back to compare (default 24 h)
 */
export async function detectQueryRegressions(
  pool: Pool,
  statsDb?: any | null,
  windowHours = 24
): Promise<QueryRegressionInfo[]> {
  try {
    // ── 1. Check pg_stat_statements is available ───────────────────────────
    const extCheck = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'"
    );
    if (extCheck.rows.length === 0) return [];

    // ── 2. Get current snapshot from pg_stat_statements ───────────────────
    const current = await pool.query(`
      SELECT queryid::text AS queryid, mean_exec_time
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_stat%'
        AND queryid IS NOT NULL
    `);

    const currentMap = new Map<string, number>();
    for (const row of current.rows) {
      currentMap.set(row.queryid, parseFloat(row.mean_exec_time));
    }

    if (!statsDb) return [];

    // ── 3. Fetch historical baselines from SQLite query_stats ─────────────
    const windowMs = windowHours * 60 * 60 * 1000;
    const since = Date.now() - windowMs;

    let historical: { queryid: string; mean_exec_time: number; timestamp: number }[];
    try {
      historical = statsDb
        .prepare(
          `SELECT queryid, mean_exec_time, timestamp
           FROM query_stats
           WHERE timestamp >= ?
           ORDER BY queryid, timestamp ASC`
        )
        .all(since) as any[];
    } catch {
      return [];
    }

    // Keep only the *earliest* record per queryid in the window
    const baselineMap = new Map<string, { meanMs: number; timestamp: number }>();
    for (const row of historical) {
      if (!baselineMap.has(row.queryid)) {
        baselineMap.set(row.queryid, {
          meanMs: row.mean_exec_time,
          timestamp: row.timestamp,
        });
      }
    }

    // ── 4. Detect regressions > 50% ────────────────────────────────────────
    const regressions: QueryRegressionInfo[] = [];

    for (const [queryId, baseline] of baselineMap) {
      const currentMean = currentMap.get(queryId);
      if (currentMean === undefined || baseline.meanMs === 0) continue;

      const changePercent =
        ((currentMean - baseline.meanMs) / baseline.meanMs) * 100;

      if (changePercent > 50) {
        regressions.push({
          queryId,
          currentMeanMs: currentMean,
          previousMeanMs: baseline.meanMs,
          changePercent: Math.round(changePercent),
          degradedAt: new Date(baseline.timestamp).toISOString(),
        });
      }
    }

    return regressions.sort((a, b) => b.changePercent - a.changePercent);
  } catch {
    return [];
  }
}
