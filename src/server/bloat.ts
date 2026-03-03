import type { Pool } from "pg";

export interface TableBloat {
  schema: string;
  table: string;
  liveRows: number;
  deadRows: number;
  bloatPercent: number;    // dead / (live + dead) * 100, rounded 1dp
  lastAutoVacuum: string | null;
  lastVacuum: string | null;
  suggestion: string;
}

export interface BloatReport {
  tables: TableBloat[];   // sorted by bloatPercent DESC, only tables with bloatPercent >= 10
  checkedAt: string;
}

function getSuggestion(table: string, bloatPercent: number): string {
  if (bloatPercent >= 50) {
    return `HIGH bloat on ${table} (${bloatPercent}% dead rows). Run: VACUUM ANALYZE ${table}`;
  } else if (bloatPercent >= 20) {
    return `Moderate bloat on ${table} (${bloatPercent}% dead rows). Consider VACUUM ANALYZE ${table}`;
  } else {
    return `Minor bloat on ${table} (${bloatPercent}% dead rows). Autovacuum should handle this.`;
  }
}

export async function getBloatReport(pool: Pool): Promise<BloatReport> {
  const result = await pool.query(`
    SELECT
      schemaname,
      relname AS table_name,
      n_live_tup,
      n_dead_tup,
      last_autovacuum,
      last_vacuum
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
      AND (n_live_tup + n_dead_tup) > 0
    ORDER BY (n_dead_tup::float / (n_live_tup + n_dead_tup)) DESC
  `);

  const tables: TableBloat[] = [];

  for (const row of result.rows) {
    const live = parseInt(row.n_live_tup, 10) || 0;
    const dead = parseInt(row.n_dead_tup, 10) || 0;
    const total = live + dead;
    if (total === 0) continue;

    const bloatPercent = Math.round((dead / total) * 1000) / 10; // 1dp
    if (bloatPercent < 10) continue;

    const table = row.table_name as string;
    tables.push({
      schema: row.schemaname as string,
      table,
      liveRows: live,
      deadRows: dead,
      bloatPercent,
      lastAutoVacuum: row.last_autovacuum ? new Date(row.last_autovacuum).toISOString() : null,
      lastVacuum: row.last_vacuum ? new Date(row.last_vacuum).toISOString() : null,
      suggestion: getSuggestion(table, bloatPercent),
    });
  }

  // Sort by bloatPercent DESC (DB query orders by dead ratio, but re-sort after filtering)
  tables.sort((a, b) => b.bloatPercent - a.bloatPercent);

  return {
    tables,
    checkedAt: new Date().toISOString(),
  };
}
