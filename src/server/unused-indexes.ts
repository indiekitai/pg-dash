import type { Pool } from "pg";

export interface UnusedIndex {
  schema: string;
  table: string;
  index: string;
  indexSize: string;       // human-readable e.g. "2.4 MB"
  indexSizeBytes: number;
  scans: number;           // idx_scan from pg_stat_user_indexes
  lastUsed: string | null; // pg_stat_reset timestamp (best effort)
  suggestion: string;
}

export interface UnusedIndexReport {
  indexes: UnusedIndex[];
  totalWastedBytes: number;
  totalWasted: string;    // human-readable
  checkedAt: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return "< 1 KB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export async function getUnusedIndexes(pool: Pool): Promise<UnusedIndexReport> {
  const result = await pool.query(`
    SELECT
      s.schemaname,
      s.relname AS table_name,
      s.indexrelname AS index_name,
      pg_relation_size(s.indexrelid) AS index_size_bytes,
      s.idx_scan,
      i.indexdef
    FROM pg_stat_user_indexes s
    JOIN pg_indexes i ON s.schemaname = i.schemaname
      AND s.relname = i.tablename
      AND s.indexrelname = i.indexname
    WHERE s.schemaname = 'public'
      AND s.idx_scan = 0
      AND i.indexdef NOT LIKE '%UNIQUE%'
      AND i.indexdef NOT LIKE '%PRIMARY KEY%'
      AND s.indexrelname NOT LIKE '%_pkey'
    ORDER BY pg_relation_size(s.indexrelid) DESC
  `);

  const indexes: UnusedIndex[] = result.rows.map((row: any) => {
    const sizeBytes = parseInt(row.index_size_bytes, 10) || 0;
    const index = row.index_name as string;
    const table = row.table_name as string;
    return {
      schema: row.schemaname as string,
      table,
      index,
      indexSize: formatBytes(sizeBytes),
      indexSizeBytes: sizeBytes,
      scans: parseInt(row.idx_scan, 10) || 0,
      lastUsed: null,
      suggestion: `Index ${index} on ${table} has never been used (0 scans). Consider dropping it: DROP INDEX CONCURRENTLY ${index}`,
    };
  });

  const totalWastedBytes = indexes.reduce((sum, idx) => sum + idx.indexSizeBytes, 0);

  return {
    indexes,
    totalWastedBytes,
    totalWasted: formatBytes(totalWastedBytes),
    checkedAt: new Date().toISOString(),
  };
}
