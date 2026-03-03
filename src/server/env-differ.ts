import { Pool } from "pg";
import { getAdvisorReport } from "./advisor.js";
import { buildLiveSnapshot } from "./schema-tracker.js";
import { diffSnapshots } from "./schema-diff.js";

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

export interface ColumnNullableDiff {
  column: string;
  sourceNullable: boolean;
  targetNullable: boolean;
}

export interface ColumnDefaultDiff {
  column: string;
  sourceDefault: string | null;
  targetDefault: string | null;
}

export interface ColumnDiff {
  table: string;
  missingColumns: ColumnInfo[]; // source has, target doesn't
  extraColumns: ColumnInfo[];   // target has, source doesn't
  typeDiffs: ColumnTypeDiff[];  // same name, different type
  nullableDiffs: ColumnNullableDiff[]; // same name, different nullable
  defaultDiffs: ColumnDefaultDiff[];   // same name, different default
}

export interface IndexDefDiff {
  name: string;
  sourceDef: string;
  targetDef: string;
}

export interface IndexDiff {
  table: string;
  missingIndexes: string[]; // source has, target doesn't
  extraIndexes: string[];   // target has, source doesn't
  modifiedIndexes: IndexDefDiff[]; // same name, different definition
}

export interface ConstraintDiff {
  table: string | null;
  type: "missing" | "extra" | "modified";
  name: string;
  detail: string;
}

export interface EnumDiff {
  type: "missing" | "extra" | "modified";
  name: string;
  detail: string;
}

export interface SchemaDiff {
  missingTables: string[];
  extraTables: string[];
  columnDiffs: ColumnDiff[];
  indexDiffs: IndexDiff[];
  constraintDiffs: ConstraintDiff[];
  enumDiffs: EnumDiff[];
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
  indexdef: string;
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
    SELECT tablename, indexname, indexdef
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
    const nullableDiffs: ColumnNullableDiff[] = [];
    const defaultDiffs: ColumnDefaultDiff[] = [];

    for (const [colName, srcInfo] of srcMap) {
      if (!tgtMap.has(colName)) {
        missingColumns.push(srcInfo);
      } else {
        const tgtInfo = tgtMap.get(colName)!;
        if (srcInfo.type !== tgtInfo.type) {
          typeDiffs.push({ column: colName, sourceType: srcInfo.type, targetType: tgtInfo.type });
        }
        if (srcInfo.nullable !== tgtInfo.nullable) {
          nullableDiffs.push({ column: colName, sourceNullable: srcInfo.nullable, targetNullable: tgtInfo.nullable });
        }
        if ((srcInfo.default ?? null) !== (tgtInfo.default ?? null)) {
          defaultDiffs.push({ column: colName, sourceDefault: srcInfo.default ?? null, targetDefault: tgtInfo.default ?? null });
        }
      }
    }

    for (const [colName, tgtInfo] of tgtMap) {
      if (!srcMap.has(colName)) {
        extraColumns.push(tgtInfo);
      }
    }

    if (missingColumns.length > 0 || extraColumns.length > 0 || typeDiffs.length > 0 ||
        nullableDiffs.length > 0 || defaultDiffs.length > 0) {
      diffs.push({ table, missingColumns, extraColumns, typeDiffs, nullableDiffs, defaultDiffs });
    }
  }

  return diffs;
}

function groupIndexesByTable(indexes: RawIndex[]): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  for (const idx of indexes) {
    if (!map.has(idx.tablename)) map.set(idx.tablename, new Map());
    map.get(idx.tablename)!.set(idx.indexname, idx.indexdef);
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

    const srcMap = srcByTable.get(table) ?? new Map<string, string>();
    const tgtMap = tgtByTable.get(table) ?? new Map<string, string>();

    const missingIndexes = [...srcMap.keys()].filter((i) => !tgtMap.has(i));
    const extraIndexes = [...tgtMap.keys()].filter((i) => !srcMap.has(i));
    const modifiedIndexes: IndexDefDiff[] = [];

    for (const [name, srcDef] of srcMap) {
      if (tgtMap.has(name)) {
        const tgtDef = tgtMap.get(name)!;
        if (srcDef !== tgtDef) {
          modifiedIndexes.push({ name, sourceDef: srcDef, targetDef: tgtDef });
        }
      }
    }

    if (missingIndexes.length > 0 || extraIndexes.length > 0 || modifiedIndexes.length > 0) {
      diffs.push({ table, missingIndexes, extraIndexes, modifiedIndexes });
    }
  }

  return diffs;
}

function countSchemaDrifts(schema: SchemaDiff): number {
  let n = schema.missingTables.length + schema.extraTables.length;
  for (const cd of schema.columnDiffs) {
    n += cd.missingColumns.length + cd.extraColumns.length + cd.typeDiffs.length +
         cd.nullableDiffs.length + cd.defaultDiffs.length;
  }
  for (const id of schema.indexDiffs) {
    n += id.missingIndexes.length + id.extraIndexes.length + id.modifiedIndexes.length;
  }
  n += (schema.constraintDiffs ?? []).length;
  n += (schema.enumDiffs ?? []).length;
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
    // Run all schema queries in parallel (basic + deep snapshots for constraints/enums)
    const [
      sourceTables,
      targetTables,
      sourceCols,
      targetCols,
      sourceIdxs,
      targetIdxs,
      sourceSnap,
      targetSnap,
    ] = await Promise.all([
      fetchTables(sourcePool),
      fetchTables(targetPool),
      fetchColumns(sourcePool),
      fetchColumns(targetPool),
      fetchIndexes(sourcePool),
      fetchIndexes(targetPool),
      buildLiveSnapshot(sourcePool).catch(() => null),
      buildLiveSnapshot(targetPool).catch(() => null),
    ]);

    const { missingTables, extraTables } = diffTables(sourceTables, targetTables);
    const targetSet = new Set(targetTables);
    const commonTables = sourceTables.filter((t) => targetSet.has(t));

    const columnDiffs = diffColumns(sourceCols, targetCols, commonTables);
    const indexDiffs = diffIndexes(sourceIdxs, targetIdxs, commonTables);

    // Constraint + enum diffs via snapshot comparison
    const constraintDiffs: ConstraintDiff[] = [];
    const enumDiffs: EnumDiff[] = [];

    if (sourceSnap && targetSnap) {
      // diffSnapshots treats source as "old" and target as "new":
      // added = target has, source doesn't (extra in target)
      // removed = source has, target doesn't (missing in target)
      const snapChanges = diffSnapshots(sourceSnap, targetSnap);

      for (const c of snapChanges) {
        if (c.object_type === "constraint") {
          constraintDiffs.push({
            table: c.table_name ?? null,
            type: c.change_type === "added" ? "extra" : c.change_type === "removed" ? "missing" : "modified",
            name: c.detail.split(" ")[1] ?? c.detail,
            detail: c.detail,
          });
        } else if (c.object_type === "enum") {
          enumDiffs.push({
            type: c.change_type === "added" ? "extra" : c.change_type === "removed" ? "missing" : "modified",
            name: c.detail.split(" ")[1] ?? c.detail,
            detail: c.detail,
          });
        }
      }
    }

    const schema: SchemaDiff = { missingTables, extraTables, columnDiffs, indexDiffs, constraintDiffs, enumDiffs };
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

  const nullableChanges: string[] = [];
  const defaultChanges: string[] = [];

  for (const cd of schema.columnDiffs) {
    for (const nd of cd.nullableDiffs) {
      const src = nd.sourceNullable ? "nullable" : "NOT NULL";
      const tgt = nd.targetNullable ? "nullable" : "NOT NULL";
      nullableChanges.push(`      ${cd.table}.${nd.column}: source=${src} → target=${tgt}`);
    }
    for (const dd of cd.defaultDiffs) {
      const src = dd.sourceDefault ?? "(none)";
      const tgt = dd.targetDefault ?? "(none)";
      defaultChanges.push(`      ${cd.table}.${dd.column}: source=${src} → target=${tgt}`);
    }
  }

  if (nullableChanges.length > 0) {
    lines.push(`  ~ nullable differences:`);
    lines.push(...nullableChanges);
  }
  if (defaultChanges.length > 0) {
    lines.push(`  ~ default differences:`);
    lines.push(...defaultChanges);
  }

  const missingIdxs: string[] = [];
  const extraIdxs: string[] = [];
  const modifiedIdxs: string[] = [];

  for (const id of schema.indexDiffs) {
    for (const idx of id.missingIndexes) {
      missingIdxs.push(`      ${id.table}: ${idx}`);
    }
    for (const idx of id.extraIndexes) {
      extraIdxs.push(`      ${id.table}: ${idx}`);
    }
    for (const mi of id.modifiedIndexes) {
      modifiedIdxs.push(`      ${id.table}: ${mi.name} source="${mi.sourceDef}" → target="${mi.targetDef}"`);
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
  if (modifiedIdxs.length > 0) {
    lines.push(`  ~ index definition differences:`);
    lines.push(...modifiedIdxs);
  }

  // Constraint diffs
  const missingConstraints = (schema.constraintDiffs ?? []).filter((c) => c.type === "missing");
  const extraConstraints = (schema.constraintDiffs ?? []).filter((c) => c.type === "extra");
  const modifiedConstraints = (schema.constraintDiffs ?? []).filter((c) => c.type === "modified");

  if (missingConstraints.length > 0) {
    lines.push(`  ✗ target missing constraints:`);
    for (const c of missingConstraints) {
      lines.push(`      ${c.table ? c.table + ": " : ""}${c.detail}`);
    }
  }
  if (extraConstraints.length > 0) {
    lines.push(`  ⚠ target has extra constraints:`);
    for (const c of extraConstraints) {
      lines.push(`      ${c.table ? c.table + ": " : ""}${c.detail}`);
    }
  }
  if (modifiedConstraints.length > 0) {
    lines.push(`  ~ constraint differences:`);
    for (const c of modifiedConstraints) {
      lines.push(`      ${c.table ? c.table + ": " : ""}${c.detail}`);
    }
  }

  // Enum diffs
  const missingEnums = (schema.enumDiffs ?? []).filter((e) => e.type === "missing");
  const extraEnums = (schema.enumDiffs ?? []).filter((e) => e.type === "extra");
  const modifiedEnums = (schema.enumDiffs ?? []).filter((e) => e.type === "modified");

  if (missingEnums.length > 0) {
    lines.push(`  ✗ target missing enums:`);
    for (const e of missingEnums) lines.push(`      ${e.detail}`);
  }
  if (extraEnums.length > 0) {
    lines.push(`  ⚠ target has extra enums:`);
    for (const e of extraEnums) lines.push(`      ${e.detail}`);
  }
  if (modifiedEnums.length > 0) {
    lines.push(`  ~ enum differences:`);
    for (const e of modifiedEnums) lines.push(`      ${e.detail}`);
  }

  const noSchemaChanges = schema.missingTables.length === 0 && schema.extraTables.length === 0 &&
      schema.columnDiffs.length === 0 && schema.indexDiffs.length === 0 &&
      (schema.constraintDiffs ?? []).length === 0 && (schema.enumDiffs ?? []).length === 0 &&
      nullableChanges.length === 0 && defaultChanges.length === 0 && modifiedIdxs.length === 0;
  if (noSchemaChanges) {
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

  const nullableItems: string[] = [];
  const defaultItems: string[] = [];

  for (const cd of schema.columnDiffs) {
    for (const nd of cd.nullableDiffs) {
      const src = nd.sourceNullable ? "nullable" : "NOT NULL";
      const tgt = nd.targetNullable ? "nullable" : "NOT NULL";
      nullableItems.push(`\`${cd.table}.${nd.column}\` (${src}→${tgt})`);
    }
    for (const dd of cd.defaultDiffs) {
      const src = dd.sourceDefault ?? "(none)";
      const tgt = dd.targetDefault ?? "(none)";
      defaultItems.push(`\`${cd.table}.${dd.column}\` (${src}→${tgt})`);
    }
  }

  if (nullableItems.length > 0) rows.push([`~ Nullable differences`, nullableItems.join(", ")]);
  if (defaultItems.length > 0) rows.push([`~ Default differences`, defaultItems.join(", ")]);

  const missingIdxItems: string[] = [];
  const extraIdxItems: string[] = [];
  const modifiedIdxItems: string[] = [];

  for (const id of schema.indexDiffs) {
    for (const idx of id.missingIndexes) missingIdxItems.push(`\`${id.table}.${idx}\``);
    for (const idx of id.extraIndexes) extraIdxItems.push(`\`${id.table}.${idx}\``);
    for (const mi of id.modifiedIndexes) modifiedIdxItems.push(`\`${id.table}.${mi.name}\``);
  }

  if (missingIdxItems.length > 0) rows.push([`❌ Missing indexes`, missingIdxItems.join(", ")]);
  if (extraIdxItems.length > 0) rows.push([`⚠️ Extra indexes`, extraIdxItems.join(", ")]);
  if (modifiedIdxItems.length > 0) rows.push([`~ Modified indexes`, modifiedIdxItems.join(", ")]);

  // Constraints
  const missingConItems = (schema.constraintDiffs ?? []).filter((c) => c.type === "missing").map((c) => c.detail);
  const extraConItems = (schema.constraintDiffs ?? []).filter((c) => c.type === "extra").map((c) => c.detail);
  const modConItems = (schema.constraintDiffs ?? []).filter((c) => c.type === "modified").map((c) => c.detail);
  if (missingConItems.length > 0) rows.push([`❌ Missing constraints`, missingConItems.join("; ")]);
  if (extraConItems.length > 0) rows.push([`⚠️ Extra constraints`, extraConItems.join("; ")]);
  if (modConItems.length > 0) rows.push([`~ Modified constraints`, modConItems.join("; ")]);

  // Enums
  const missingEnumItems = (schema.enumDiffs ?? []).filter((e) => e.type === "missing").map((e) => e.detail);
  const extraEnumItems = (schema.enumDiffs ?? []).filter((e) => e.type === "extra").map((e) => e.detail);
  const modEnumItems = (schema.enumDiffs ?? []).filter((e) => e.type === "modified").map((e) => e.detail);
  if (missingEnumItems.length > 0) rows.push([`❌ Missing enums`, missingEnumItems.join("; ")]);
  if (extraEnumItems.length > 0) rows.push([`⚠️ Extra enums`, extraEnumItems.join("; ")]);
  if (modEnumItems.length > 0) rows.push([`~ Modified enums`, modEnumItems.join("; ")]);

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
