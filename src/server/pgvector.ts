import type { Pool } from "pg";

export interface VectorColumn {
  schema: string;
  table: string;
  column: string;
  dimensions: number | null;
  rowCount: number;
}

export interface VectorIndex {
  schema: string;
  table: string;
  indexName: string;
  indexType: "ivfflat" | "hnsw" | "unknown";
  indexSize: string;
  indexSizeBytes: number;
  tableSize: string;
  tableSizeBytes: number;
  sizeRatio: number;
  params: Record<string, string>;
  suggestion: string | null;
}

export interface PgvectorReport {
  installed: boolean;
  version: string | null;
  columns: VectorColumn[];
  indexes: VectorIndex[];
  issues: PgvectorIssue[];
  checkedAt: string;
}

export interface PgvectorIssue {
  severity: "critical" | "warning" | "info";
  title: string;
  suggestion: string;
}

function analyzeIndex(idx: VectorIndex, columns: VectorColumn[]): string | null {
  if (idx.indexType === "ivfflat") {
    const lists = parseInt(idx.params.lists || "0", 10);
    const col = columns.find(c => c.table === idx.table);
    const rows = col?.rowCount || 0;
    if (rows > 0 && lists > 0) {
      const idealLists = Math.max(1, Math.round(Math.sqrt(rows)));
      if (lists < idealLists * 0.5) {
        return `IVFFlat lists=${lists} is low for ${rows.toLocaleString()} rows. Consider lists=${idealLists} (sqrt of row count).`;
      }
      if (lists > idealLists * 3) {
        return `IVFFlat lists=${lists} is high for ${rows.toLocaleString()} rows. Consider lists=${idealLists} (sqrt of row count).`;
      }
    }
  }
  if (idx.indexType === "hnsw") {
    const m = parseInt(idx.params.m || "16", 10);
    const efConstruction = parseInt(idx.params.ef_construction || "64", 10);
    if (efConstruction < 2 * m) {
      return `HNSW ef_construction=${efConstruction} should be >= 2*m (${2 * m}) for good recall.`;
    }
  }
  if (idx.sizeRatio > 3) {
    return `Index ${idx.indexName} is ${idx.sizeRatio.toFixed(1)}x the table size. This is unusually large — check dimensions and index type.`;
  }
  return null;
}

export async function getPgvectorReport(pool: Pool): Promise<PgvectorReport> {
  const extResult = await pool.query(`
    SELECT extversion FROM pg_extension WHERE extname = 'vector'
  `);

  if (extResult.rows.length === 0) {
    return {
      installed: false,
      version: null,
      columns: [],
      indexes: [],
      issues: [],
      checkedAt: new Date().toISOString(),
    };
  }

  const version = extResult.rows[0].extversion as string;

  const [colResult, idxResult] = await Promise.all([
    pool.query(`
      SELECT
        c.table_schema,
        c.table_name,
        c.column_name,
        c.udt_name,
        (SELECT reltuples::bigint FROM pg_class WHERE oid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass) AS row_count
      FROM information_schema.columns c
      WHERE c.udt_name = 'vector'
        AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY c.table_schema, c.table_name, c.column_name
    `),
    pool.query(`
      SELECT
        schemaname,
        tablename,
        indexname,
        indexdef,
        pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(indexname)) AS index_size_bytes,
        pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)) AS table_size_bytes,
        pg_size_pretty(pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(indexname))) AS index_size,
        pg_size_pretty(pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))) AS table_size
      FROM pg_indexes
      WHERE indexdef ILIKE '%vector%'
        OR indexdef ILIKE '%ivfflat%'
        OR indexdef ILIKE '%hnsw%'
      ORDER BY pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(indexname)) DESC
    `),
  ]);

  const columns: VectorColumn[] = colResult.rows.map((row: any) => {
    const dimMatch = row.column_name ? null : null;
    return {
      schema: row.table_schema,
      table: row.table_name,
      column: row.column_name,
      dimensions: null,
      rowCount: parseInt(row.row_count, 10) || 0,
    };
  });

  // Get actual dimensions by sampling
  for (const col of columns) {
    try {
      const dimResult = await pool.query(
        `SELECT vector_dims(${col.column}) AS dims FROM ${col.schema}.${col.table} WHERE ${col.column} IS NOT NULL LIMIT 1`
      );
      if (dimResult.rows.length > 0) {
        col.dimensions = parseInt(dimResult.rows[0].dims, 10) || null;
      }
    } catch {
      // column might be empty or have other issues
    }
  }

  const indexes: VectorIndex[] = idxResult.rows.map((row: any) => {
    const def = (row.indexdef as string).toLowerCase();
    let indexType: VectorIndex["indexType"] = "unknown";
    if (def.includes("ivfflat")) indexType = "ivfflat";
    else if (def.includes("hnsw")) indexType = "hnsw";

    const params: Record<string, string> = {};
    const withMatch = def.match(/with\s*\(([^)]+)\)/);
    if (withMatch) {
      for (const pair of withMatch[1].split(",")) {
        const [k, v] = pair.split("=").map(s => s.trim());
        if (k && v) params[k] = v;
      }
    }

    const idxSizeBytes = parseInt(row.index_size_bytes, 10) || 0;
    const tblSizeBytes = parseInt(row.table_size_bytes, 10) || 1;

    const idx: VectorIndex = {
      schema: row.schemaname,
      table: row.tablename,
      indexName: row.indexname,
      indexType,
      indexSize: row.index_size,
      indexSizeBytes: idxSizeBytes,
      tableSize: row.table_size,
      tableSizeBytes: tblSizeBytes,
      sizeRatio: Math.round((idxSizeBytes / tblSizeBytes) * 10) / 10,
      params,
      suggestion: null,
    };

    idx.suggestion = analyzeIndex(idx, columns);
    return idx;
  });

  const issues: PgvectorIssue[] = [];

  // Check for vector columns without indexes
  for (const col of columns) {
    const hasIndex = indexes.some(i => i.table === col.table);
    if (!hasIndex && col.rowCount > 1000) {
      issues.push({
        severity: "warning",
        title: `No vector index on ${col.schema}.${col.table}.${col.column} (${col.rowCount.toLocaleString()} rows)`,
        suggestion: `CREATE INDEX ON ${col.schema}.${col.table} USING hnsw (${col.column} vector_cosine_ops)${col.dimensions && col.dimensions > 2000 ? " — note: dimensions > 2000, consider dimensionality reduction" : ""}`,
      });
    }
  }

  // High-dimension warnings
  for (const col of columns) {
    if (col.dimensions && col.dimensions > 2000) {
      issues.push({
        severity: "info",
        title: `High-dimensional vectors (${col.dimensions}d) on ${col.table}.${col.column}`,
        suggestion: "Consider dimensionality reduction (PCA, Matryoshka embeddings) for better index performance. HNSW recall degrades above ~2000 dimensions.",
      });
    }
  }

  // Index-specific issues
  for (const idx of indexes) {
    if (idx.suggestion) {
      issues.push({
        severity: "warning",
        title: `${idx.indexName}: ${idx.suggestion}`,
        suggestion: idx.suggestion,
      });
    }
  }

  // Version check
  const [major, minor] = version.split(".").map(Number);
  if (major === 0 && minor < 7) {
    issues.push({
      severity: "info",
      title: `pgvector ${version} — consider upgrading to 0.7+ for HNSW improvements`,
      suggestion: "pgvector 0.7+ has significant HNSW performance improvements and parallel index builds.",
    });
  }

  return {
    installed: true,
    version,
    columns,
    indexes,
    issues,
    checkedAt: new Date().toISOString(),
  };
}
