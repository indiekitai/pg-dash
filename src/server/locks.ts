import type { Pool } from "pg";

export interface LockWait {
  blockedPid: number;
  blockedQuery: string;
  blockedDuration: string;   // e.g. "00:00:45"
  blockingPid: number;
  blockingQuery: string;
  blockingDuration: string;
  table: string | null;
  lockType: string;
}

export interface LockReport {
  waitingLocks: LockWait[];
  longRunningQueries: Array<{
    pid: number;
    duration: string;
    query: string;
    state: string;
    waitEventType: string | null;
  }>;
  checkedAt: string;
}

export function formatDurationSecs(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [
    String(h).padStart(2, "0"),
    String(m).padStart(2, "0"),
    String(s).padStart(2, "0"),
  ].join(":");
}

export async function getLockReport(pool: Pool): Promise<LockReport> {
  const [locksResult, longResult] = await Promise.all([
    pool.query(`
      SELECT
        blocked.pid AS blocked_pid,
        blocked.query AS blocked_query,
        EXTRACT(EPOCH FROM (NOW() - blocked.query_start))::int AS blocked_secs,
        blocking.pid AS blocking_pid,
        blocking.query AS blocking_query,
        EXTRACT(EPOCH FROM (NOW() - blocking.query_start))::int AS blocking_secs,
        blocked_locks.relation::regclass::text AS table_name,
        blocked_locks.locktype
      FROM pg_catalog.pg_locks blocked_locks
      JOIN pg_catalog.pg_stat_activity blocked ON blocked.pid = blocked_locks.pid
      JOIN pg_catalog.pg_locks blocking_locks
        ON blocking_locks.locktype = blocked_locks.locktype
        AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
        AND blocking_locks.pid != blocked_locks.pid
        AND blocking_locks.granted = true
      JOIN pg_catalog.pg_stat_activity blocking ON blocking.pid = blocking_locks.pid
      WHERE NOT blocked_locks.granted
    `),
    pool.query(`
      SELECT
        pid,
        EXTRACT(EPOCH FROM (NOW() - query_start))::int AS duration_secs,
        query,
        state,
        wait_event_type
      FROM pg_stat_activity
      WHERE state != 'idle'
        AND query_start IS NOT NULL
        AND EXTRACT(EPOCH FROM (NOW() - query_start)) > 5
        AND query NOT LIKE '%pg_stat_activity%'
      ORDER BY duration_secs DESC
      LIMIT 20
    `),
  ]);

  // Deduplicate by (blockedPid, blockingPid) — same pair may appear multiple times
  // for different lock types; keep only the first occurrence.
  const seen = new Set<string>();
  const waitingLocks: LockWait[] = [];
  for (const row of locksResult.rows) {
    const key = `${row.blocked_pid}:${row.blocking_pid}`;
    if (!seen.has(key)) {
      seen.add(key);
      waitingLocks.push({
        blockedPid: parseInt(row.blocked_pid, 10),
        blockedQuery: row.blocked_query as string,
        blockedDuration: formatDurationSecs(parseInt(row.blocked_secs, 10) || 0),
        blockingPid: parseInt(row.blocking_pid, 10),
        blockingQuery: row.blocking_query as string,
        blockingDuration: formatDurationSecs(parseInt(row.blocking_secs, 10) || 0),
        table: row.table_name ?? null,
        lockType: row.locktype as string,
      });
    }
  }

  const longRunningQueries = longResult.rows.map((row: any) => ({
    pid: parseInt(row.pid, 10),
    duration: formatDurationSecs(parseInt(row.duration_secs, 10) || 0),
    query: row.query as string,
    state: row.state as string,
    waitEventType: row.wait_event_type ?? null,
  }));

  return {
    waitingLocks,
    longRunningQueries,
    checkedAt: new Date().toISOString(),
  };
}
