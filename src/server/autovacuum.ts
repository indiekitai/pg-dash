import type { Pool } from "pg";

export interface AutovacuumTableStatus {
  schema: string;
  table: string;
  lastAutoVacuum: string | null;
  lastAutoAnalyze: string | null;
  deadTuples: number;
  liveTuples: number;
  vacuumCount: number;
  analyzeCount: number;
  status: "ok" | "stale" | "never" | "overdue";
  suggestion: string | null;
}

export interface AutovacuumReport {
  tables: AutovacuumTableStatus[];
  settings: {
    autovacuumEnabled: boolean;
    vacuumCostDelay: string;
    autovacuumMaxWorkers: number;
    autovacuumNaptime: string;
  };
  checkedAt: string;
}

function classifyStatus(
  lastAutoVacuum: Date | null,
  vacuumCount: number,
  deadTuples: number,
  now: Date
): "ok" | "stale" | "never" | "overdue" {
  if (lastAutoVacuum === null && vacuumCount === 0) return "never";

  if (lastAutoVacuum !== null) {
    const ageDays = (now.getTime() - lastAutoVacuum.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > 7 && deadTuples > 10000) return "overdue";
    if (ageDays > 3) return "stale";
  }

  return "ok";
}

function getSuggestion(status: "ok" | "stale" | "never" | "overdue", table: string): string | null {
  switch (status) {
    case "never":
      return `Table ${table} has never been autovacuumed. Check if autovacuum is enabled and the table has enough churn.`;
    case "overdue":
      return `Table ${table} is overdue for vacuum and has many dead tuples. Run: VACUUM ANALYZE ${table}`;
    case "stale":
      return `Table ${table} hasn't been vacuumed in over 3 days. Monitor for bloat.`;
    case "ok":
      return null;
  }
}

export async function getAutovacuumReport(pool: Pool): Promise<AutovacuumReport> {
  const [tableResult, settingsResult] = await Promise.all([
    pool.query(`
      SELECT
        schemaname, relname,
        last_autovacuum, last_autoanalyze,
        n_dead_tup, n_live_tup,
        autovacuum_count, autoanalyze_count
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY n_dead_tup DESC
    `),
    pool.query(`
      SELECT name, setting
      FROM pg_settings
      WHERE name IN ('autovacuum', 'autovacuum_vacuum_cost_delay', 'autovacuum_max_workers', 'autovacuum_naptime')
    `),
  ]);

  const now = new Date();

  const tables: AutovacuumTableStatus[] = tableResult.rows.map((row: any) => {
    const lastAutoVacuumDate = row.last_autovacuum ? new Date(row.last_autovacuum) : null;
    const deadTuples = parseInt(row.n_dead_tup, 10) || 0;
    const liveTuples = parseInt(row.n_live_tup, 10) || 0;
    const vacuumCount = parseInt(row.autovacuum_count, 10) || 0;
    const analyzeCount = parseInt(row.autoanalyze_count, 10) || 0;
    const status = classifyStatus(lastAutoVacuumDate, vacuumCount, deadTuples, now);
    const table = row.relname as string;

    return {
      schema: row.schemaname as string,
      table,
      lastAutoVacuum: lastAutoVacuumDate ? lastAutoVacuumDate.toISOString() : null,
      lastAutoAnalyze: row.last_autoanalyze ? new Date(row.last_autoanalyze).toISOString() : null,
      deadTuples,
      liveTuples,
      vacuumCount,
      analyzeCount,
      status,
      suggestion: getSuggestion(status, table),
    };
  });

  const settingsMap: Record<string, string> = {};
  for (const row of settingsResult.rows) {
    settingsMap[row.name] = row.setting;
  }

  return {
    tables,
    settings: {
      autovacuumEnabled: settingsMap["autovacuum"] !== "off",
      vacuumCostDelay: settingsMap["autovacuum_vacuum_cost_delay"] ?? "2",
      autovacuumMaxWorkers: parseInt(settingsMap["autovacuum_max_workers"] ?? "3", 10),
      autovacuumNaptime: settingsMap["autovacuum_naptime"] ?? "60",
    },
    checkedAt: new Date().toISOString(),
  };
}
