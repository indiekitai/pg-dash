import { Pool } from "pg";
import { getAdvisorReport } from "./advisor.js";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
}

export interface ColumnTypeDiff {
  column: string;
  sourceType: string;
  targetType: string;
}

export interface ColumnDiff {
  table: string;
  missingColumns: ColumnInfo[]; // source has, target doesn't
  extraColumns: ColumnInfo[];   // target has, source doesn't
  typeDiffs: ColumnTypeDiff[];  // same name, different type
}

export interface IndexDiff {
  table: string;
  missingIndexes: string[]; // source has, target doesn't
  extraIndexes: string[];   // target has, source doesn't
}

export interface SchemaDiff {
  missingTables: string[];
  extraTables: string[];
  columnDiffs: ColumnDiff[];
  indexDiffs: IndexDiff[];
}

export interface HealthDiff {
  source: { score: number; grade: string; url: string };
  target: { score: number; grade: string; url: string };
  sourceOnlyIssues: string[];
  targetOnlyIssues: string[];
}

export interface EnvDiffResult {
  schema: SchemaDiff;
  health?: HealthDiff;
  checkedAt: string;
  summary: {
    schemaDrifts: number;
    identical: boolean;
  };
}

// ----- internal types -----

interface RawColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface RawIndex {
  tablename: string;
  indexname: string;
}

// ----- query helpers -----

async function fetchTables(pool: Pool): Promise<string[]> {
  const res = await pool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return res.rows.map((r) => r.table_name);
}

async function fetchColumns(pool: Pool): Promise<RawColumn[]> {
  const res = await pool.query<RawColumn>(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  return res.rows;
}

async function fetchIndexes(pool: Pool): Promise<RawIndex[]> {
  const res = await pool.query<RawIndex>(`
    SELECT tablename, indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND indexname NOT LIKE '%_pkey'
    ORDER BY tablename, indexname
  `);
  return res.rows;
}

// ----- diff logic -----

function diffTables(sourceTables: string[], targetTables: string[]): { missingTables: string[]; extraTables: string[] } {
  const sourceSet = new Set(sourceTables);
  const targetSet = new Set(targetTables);
  return {
    missingTables: sourceTables.filter((t) => !targetSet.has(t)),
    extraTables: targetTables.filter((t) => !sourceSet.has(t)),
  };
}

function groupColumnsByTable(columns: RawColumn[]): Map<string, Map<string, ColumnInfo>> {
  const map = new Map<string, Map<string, ColumnInfo>>();
  for (const col of columns) {
    if (!map.has(col.table_name)) map.set(col.table_name, new Map());
    const info: ColumnInfo = {
      name: col.column_name,
      type: col.data_type,
      nullable: col.is_nullable === "YES",
    };
    if (col.column_default !== null && col.column_default !== undefined) {
      info.default = col.column_default;
    }
    map.get(col.table_name)!.set(col.column_name, info);
  }
  return map;
}

function diffColumns(
  sourceCols: RawColumn[],
  targetCols: RawColumn[],
  commonTables: string[]
): ColumnDiff[] {
  const sourceByTable = groupColumnsByTable(sourceCols);
  const targetByTable = groupColumnsByTable(targetCols);
  const diffs: ColumnDiff[] = [];

  for (const table of commonTables) {
    const srcMap = sourceByTable.get(table) ?? new Map<string, ColumnInfo>();
    const tgtMap = targetByTable.get(table) ?? new Map<string, ColumnInfo>();

    const missingColumns: ColumnInfo[] = [];
    const extraColumns: ColumnInfo[] = [];
    const typeDiffs: ColumnTypeDiff[] = [];

    for (const [colName, srcInfo] of srcMap) {
      if (!tgtMap.has(colName)) {
        missingColumns.push(srcInfo);
      } else {
        const tgtInfo = tgtMap.get(colName)!;
        if (srcInfo.type !== tgtInfo.type) {
          typeDiffs.push({ column: colName, sourceType: srcInfo.type, targetType: tgtInfo.type });
        }
      }
    }

    for (const [colName, tgtInfo] of tgtMap) {
      if (!srcMap.has(colName)) {
        extraColumns.push(tgtInfo);
      }
    }

    if (missingColumns.length > 0 || extraColumns.length > 0 || typeDiffs.length > 0) {
      diffs.push({ table, missingColumns, extraColumns, typeDiffs });
    }
  }

  return diffs;
}

function groupIndexesByTable(indexes: RawIndex[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const idx of indexes) {
    if (!map.has(idx.tablename)) map.set(idx.tablename, new Set());
    map.get(idx.tablename)!.add(idx.indexname);
  }
  return map;
}

function diffIndexes(
  sourceIdxs: RawIndex[],
  targetIdxs: RawIndex[],
  commonTables: string[]
): IndexDiff[] {
  const srcByTable = groupIndexesByTable(sourceIdxs);
  const tgtByTable = groupIndexesByTable(targetIdxs);
  const diffs: IndexDiff[] = [];

  // All tables that have any indexes in source or target
  const allTables = new Set([
    ...sourceIdxs.map((i) => i.tablename),
    ...targetIdxs.map((i) => i.tablename),
  ]);

  for (const table of allTables) {
    // Only diff tables that exist in both environments (common tables + tables not in either missingTables/extraTables)
    if (!commonTables.includes(table)) continue;

    const srcSet = srcByTable.get(table) ?? new Set<string>();
    const tgtSet = tgtByTable.get(table) ?? new Set<string>();

    const missingIndexes = [...srcSet].filter((i) => !tgtSet.has(i));
    const extraIndexes = [...tgtSet].filter((i) => !srcSet.has(i));

    if (missingIndexes.length > 0 || extraIndexes.length > 0) {
      diffs.push({ table, missingIndexes, extraIndexes });
    }
  }

  return diffs;
}

function countSchemaDrifts(schema: SchemaDiff): number {
  let n = schema.missingTables.length + schema.extraTables.length;
  for (const cd of schema.columnDiffs) {
    n += cd.missingColumns.length + cd.extraColumns.length + cd.typeDiffs.length;
  }
  for (const id of schema.indexDiffs) {
    n += id.missingIndexes.length + id.extraIndexes.length;
  }
  return n;
}

// ----- public API -----

export async function diffEnvironments(
  sourceConn: string,
  targetConn: string,
  options?: { includeHealth?: boolean }
): Promise<EnvDiffResult> {
  const sourcePool = new Pool({ connectionString: sourceConn, connectionTimeoutMillis: 10000 });
  const targetPool = new Pool({ connectionString: targetConn, connectionTimeoutMillis: 10000 });

  try {
    // Run schema queries in parallel
    const [
      sourceTables,
      targetTables,
      sourceCols,
      targetCols,
      sourceIdxs,
      targetIdxs,
    ] = await Promise.all([
      fetchTables(sourcePool),
      fetchTables(targetPool),
      fetchColumns(sourcePool),
      fetchColumns(targetPool),
      fetchIndexes(sourcePool),
      fetchIndexes(targetPool),
    ]);

    const { missingTables, extraTables } = diffTables(sourceTables, targetTables);
    const sourceSet = new Set(sourceTables);
    const targetSet = new Set(targetTables);
    const commonTables = sourceTables.filter((t) => targetSet.has(t));

    const columnDiffs = diffColumns(sourceCols, targetCols, commonTables);
    const indexDiffs = diffIndexes(sourceIdxs, targetIdxs, commonTables);

    const schema: SchemaDiff = { missingTables, extraTables, columnDiffs, indexDiffs };
    const schemaDrifts = countSchemaDrifts(schema);

    let health: HealthDiff | undefined;

    if (options?.includeHealth) {
      const longQueryThreshold = 5;
      const [srcReport, tgtReport] = await Promise.all([
        getAdvisorReport(sourcePool, longQueryThreshold),
        getAdvisorReport(targetPool, longQueryThreshold),
      ]);

      const srcIssueKeys = new Set(srcReport.issues.map((i) => i.title));
      const tgtIssueKeys = new Set(tgtReport.issues.map((i) => i.title));

      const sourceOnlyIssues = srcReport.issues
        .filter((i) => !tgtIssueKeys.has(i.title))
        .map((i) => `${i.severity}: ${i.title}`);

      const targetOnlyIssues = tgtReport.issues
        .filter((i) => !srcIssueKeys.has(i.title))
        .map((i) => `${i.severity}: ${i.title}`);

      health = {
        source: { score: srcReport.score, grade: srcReport.grade, url: maskConnectionString(sourceConn) },
        target: { score: tgtReport.score, grade: tgtReport.grade, url: maskConnectionString(targetConn) },
        sourceOnlyIssues,
        targetOnlyIssues,
      };
    }

    return {
      schema,
      health,
      checkedAt: new Date().toISOString(),
      summary: {
        schemaDrifts,
        identical: schemaDrifts === 0,
      },
    };
  } finally {
    await Promise.allSettled([sourcePool.end(), targetPool.end()]);
  }
}

/** Mask password in a connection string to avoid leaking credentials */
function maskConnectionString(connStr: string): string {
  try {
    const url = new URL(connStr);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<redacted>";
  }
}

// ----- formatters -----

export function formatTextDiff(result: EnvDiffResult): string {
  const lines: string[] = [];
  const sep = "══════════════════════════════════════";

  lines.push(`Environment Diff`);
  lines.push(sep);
  lines.push(``);
  lines.push(`Schema Drift:`);

  const { schema } = result;

  if (schema.missingTables.length > 0) {
    lines.push(`  ✗ target missing tables: ${schema.missingTables.join(", ")}`);
  }
  if (schema.extraTables.length > 0) {
    lines.push(`  ⚠ target has extra tables: ${schema.extraTables.join(", ")}`);
  }

  const missingCols: string[] = [];
  const extraCols: string[] = [];
  const typeChanges: string[] = [];

  for (const cd of schema.columnDiffs) {
    for (const col of cd.missingColumns) {
      missingCols.push(`      ${cd.table}: ${col.name} (${col.type})`);
    }
    for (const col of cd.extraColumns) {
      extraCols.push(`      ${cd.table}: ${col.name} (${col.type})`);
    }
    for (const td of cd.typeDiffs) {
      typeChanges.push(`      ${cd.table}.${td.column}: ${td.sourceType} → ${td.targetType}`);
    }
  }

  if (missingCols.length > 0) {
    lines.push(`  ✗ target missing columns:`);
    lines.push(...missingCols);
  }
  if (extraCols.length > 0) {
    lines.push(`  ⚠ target has extra columns:`);
    lines.push(...extraCols);
  }
  if (typeChanges.length > 0) {
    lines.push(`  ~ column type differences:`);
    lines.push(...typeChanges);
  }

  const missingIdxs: string[] = [];
  const extraIdxs: string[] = [];

  for (const id of schema.indexDiffs) {
    for (const idx of id.missingIndexes) {
      missingIdxs.push(`      ${id.table}: ${idx}`);
    }
    for (const idx of id.extraIndexes) {
      extraIdxs.push(`      ${id.table}: ${idx}`);
    }
  }

  if (missingIdxs.length > 0) {
    lines.push(`  ✗ target missing indexes:`);
    lines.push(...missingIdxs);
  }
  if (extraIdxs.length > 0) {
    lines.push(`  ⚠ target has extra indexes:`);
    lines.push(...extraIdxs);
  }

  if (schema.missingTables.length === 0 && schema.extraTables.length === 0 &&
      schema.columnDiffs.length === 0 && schema.indexDiffs.length === 0) {
    lines.push(`  ✓ Schemas are identical`);
  }

  if (result.health) {
    const h = result.health;
    lines.push(``);
    lines.push(`Health Comparison:`);
    lines.push(`  Source: ${h.source.score}/100 (${h.source.grade})  |  Target: ${h.target.score}/100 (${h.target.grade})`);
    lines.push(`  Source-only issues: ${h.sourceOnlyIssues.length === 0 ? "(none)" : ""}`);
    for (const iss of h.sourceOnlyIssues) lines.push(`    - ${iss}`);
    lines.push(`  Target-only issues: ${h.targetOnlyIssues.length === 0 ? "(none)" : ""}`);
    for (const iss of h.targetOnlyIssues) lines.push(`    - ${iss}`);
  }

  lines.push(``);
  lines.push(sep);
  const { schemaDrifts, identical } = result.summary;
  lines.push(`Total: ${schemaDrifts} schema drift${schemaDrifts !== 1 ? "s" : ""} | Environments are ${identical ? "in sync ✓" : "NOT in sync ✗"}`);

  return lines.join("\n");
}

export function formatMdDiff(result: EnvDiffResult): string {
  const lines: string[] = [];
  lines.push(`## 🔄 Environment Diff`);
  lines.push(``);
  lines.push(`### Schema Drift`);
  lines.push(``);

  const { schema } = result;
  const rows: Array<[string, string]> = [];

  if (schema.missingTables.length > 0) {
    rows.push([`❌ Missing tables`, schema.missingTables.map((t) => `\`${t}\``).join(", ")]);
  }
  if (schema.extraTables.length > 0) {
    rows.push([`⚠️ Extra tables`, schema.extraTables.map((t) => `\`${t}\``).join(", ")]);
  }

  const missingColItems: string[] = [];
  const extraColItems: string[] = [];
  const typeItems: string[] = [];

  for (const cd of schema.columnDiffs) {
    for (const col of cd.missingColumns) {
      missingColItems.push(`\`${cd.table}.${col.name}\``);
    }
    for (const col of cd.extraColumns) {
      extraColItems.push(`\`${cd.table}.${col.name}\``);
    }
    for (const td of cd.typeDiffs) {
      typeItems.push(`\`${cd.table}.${td.column}\` (${td.sourceType}→${td.targetType})`);
    }
  }

  if (missingColItems.length > 0) rows.push([`❌ Missing columns`, missingColItems.join(", ")]);
  if (extraColItems.length > 0) rows.push([`⚠️ Extra columns`, extraColItems.join(", ")]);
  if (typeItems.length > 0) rows.push([`~ Type differences`, typeItems.join(", ")]);

  const missingIdxItems: string[] = [];
  const extraIdxItems: string[] = [];

  for (const id of schema.indexDiffs) {
    for (const idx of id.missingIndexes) missingIdxItems.push(`\`${id.table}.${idx}\``);
    for (const idx of id.extraIndexes) extraIdxItems.push(`\`${id.table}.${idx}\``);
  }

  if (missingIdxItems.length > 0) rows.push([`❌ Missing indexes`, missingIdxItems.join(", ")]);
  if (extraIdxItems.length > 0) rows.push([`⚠️ Extra indexes`, extraIdxItems.join(", ")]);

  if (rows.length > 0) {
    lines.push(`| Type | Details |`);
    lines.push(`|------|---------|`);
    for (const [type, details] of rows) {
      lines.push(`| ${type} | ${details} |`);
    }
  } else {
    lines.push(`✅ Schemas are identical`);
  }

  if (result.health) {
    const h = result.health;
    lines.push(``);
    lines.push(`### Health Comparison`);
    lines.push(``);
    lines.push(`| | Score | Grade |`);
    lines.push(`|--|-------|-------|`);
    lines.push(`| Source | ${h.source.score}/100 | ${h.source.grade} |`);
    lines.push(`| Target | ${h.target.score}/100 | ${h.target.grade} |`);

    if (h.targetOnlyIssues.length > 0) {
      lines.push(``);
      lines.push(`**Target-only issues:**`);
      for (const iss of h.targetOnlyIssues) lines.push(`- ${iss}`);
    }
    if (h.sourceOnlyIssues.length > 0) {
      lines.push(``);
      lines.push(`**Source-only issues:**`);
      for (const iss of h.sourceOnlyIssues) lines.push(`- ${iss}`);
    }
  }

  lines.push(``);
  const { schemaDrifts, identical } = result.summary;
  lines.push(`**Result: ${schemaDrifts} drift${schemaDrifts !== 1 ? "s" : ""} — environments are ${identical ? "in sync ✓" : "NOT in sync"}**`);

  return lines.join("\n");
}
