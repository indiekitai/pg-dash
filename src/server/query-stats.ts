import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Pool } from "pg";

const DEFAULT_DIR = path.join(os.homedir(), ".pg-dash");
const DEFAULT_RETENTION_DAYS = 7;

export interface QueryStatRow {
  timestamp: number;
  queryid: string;
  query: string;
  calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  min_exec_time: number;
  max_exec_time: number;
  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
}

export interface TopQuery {
  queryid: string;
  query: string;
  total_calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  total_rows: number;
}

interface CumulativeRow {
  queryid: string;
  query: string;
  calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  min_exec_time: number;
  max_exec_time: number;
  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
}

export class QueryStatsStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private retentionMs: number;
  private prev: Map<string, CumulativeRow> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir?: string, retentionDays = DEFAULT_RETENTION_DAYS) {
    const dir = dataDir || DEFAULT_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "metrics.db");
    this.db = new Database(dbPath);
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS query_stats (
        timestamp INTEGER NOT NULL,
        queryid TEXT NOT NULL,
        query TEXT,
        calls INTEGER,
        total_exec_time REAL,
        mean_exec_time REAL,
        min_exec_time REAL,
        max_exec_time REAL,
        rows INTEGER,
        shared_blks_hit INTEGER,
        shared_blks_read INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_qs_queryid_ts ON query_stats(queryid, timestamp);
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO query_stats (timestamp, queryid, query, calls, total_exec_time, mean_exec_time, min_exec_time, max_exec_time, rows, shared_blks_hit, shared_blks_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }

  startPeriodicSnapshot(pool: Pool, intervalMs = 5 * 60 * 1000): void {
    this.snapshot(pool).catch((err) =>
      console.error("[query-stats] Initial snapshot failed:", err.message)
    );
    this.timer = setInterval(() => {
      this.snapshot(pool).catch((err) =>
        console.error("[query-stats] Snapshot failed:", err.message)
      );
    }, intervalMs);
    // Prune once per hour
    setInterval(() => this.prune(), 60 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async snapshot(pool: Pool): Promise<number> {
    const client = await pool.connect();
    try {
      // Check if pg_stat_statements is available
      const extCheck = await client.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'"
      );
      if (extCheck.rows.length === 0) return 0;

      const r = await client.query(`
        SELECT
          queryid::text,
          query,
          calls::int,
          total_exec_time,
          mean_exec_time,
          min_exec_time,
          max_exec_time,
          rows::int,
          shared_blks_hit::int,
          shared_blks_read::int
        FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat%'
          AND query NOT LIKE '%pg_catalog%'
          AND queryid IS NOT NULL
      `);

      const now = Date.now();
      const hasPrev = this.prev.size > 0;
      let count = 0;

      const tx = this.db.transaction((rows: CumulativeRow[]) => {
        for (const row of rows) {
          const prev = this.prev.get(row.queryid);
          if (hasPrev && prev) {
            const deltaCalls = Math.max(0, row.calls - prev.calls);
            if (deltaCalls === 0) continue; // no new activity
            const deltaTime = Math.max(0, row.total_exec_time - prev.total_exec_time);
            const deltaRows = Math.max(0, row.rows - prev.rows);
            const deltaHit = Math.max(0, row.shared_blks_hit - prev.shared_blks_hit);
            const deltaRead = Math.max(0, row.shared_blks_read - prev.shared_blks_read);
            const meanTime = deltaCalls > 0 ? deltaTime / deltaCalls : 0;

            this.insertStmt.run(
              now, row.queryid, row.query,
              deltaCalls, deltaTime, meanTime,
              row.min_exec_time, row.max_exec_time,
              deltaRows, deltaHit, deltaRead
            );
            count++;
          } else if (!hasPrev) {
            // First snapshot: store cumulative values
            this.insertStmt.run(
              now, row.queryid, row.query,
              row.calls, row.total_exec_time, row.mean_exec_time,
              row.min_exec_time, row.max_exec_time,
              row.rows, row.shared_blks_hit, row.shared_blks_read
            );
            count++;
          }
        }
      });

      tx(r.rows);

      // Update prev state
      this.prev.clear();
      for (const row of r.rows) {
        this.prev.set(row.queryid, row);
      }

      return count;
    } catch (err) {
      console.error("[query-stats] Error snapshotting:", (err as Error).message);
      return 0;
    } finally {
      client.release();
    }
  }

  /** Insert a row directly (for testing) */
  insertRow(row: QueryStatRow): void {
    this.insertStmt.run(
      row.timestamp, row.queryid, row.query,
      row.calls, row.total_exec_time, row.mean_exec_time,
      row.min_exec_time, row.max_exec_time,
      row.rows, row.shared_blks_hit, row.shared_blks_read
    );
  }

  getTrend(queryid: string, startMs: number, endMs?: number): QueryStatRow[] {
    const end = endMs ?? Date.now();
    return this.db
      .prepare(
        `SELECT timestamp, queryid, query, calls, total_exec_time, mean_exec_time,
                min_exec_time, max_exec_time, rows, shared_blks_hit, shared_blks_read
         FROM query_stats
         WHERE queryid = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp`
      )
      .all(queryid, startMs, end) as QueryStatRow[];
  }

  getTopQueries(
    startMs: number,
    endMs: number,
    orderBy: "total_time" | "mean_time" | "calls" = "total_time",
    limit = 20
  ): TopQuery[] {
    const orderCol =
      orderBy === "total_time" ? "SUM(total_exec_time)"
      : orderBy === "calls" ? "SUM(calls)"
      : "AVG(mean_exec_time)";

    return this.db
      .prepare(
        `SELECT queryid, 
                MAX(query) as query,
                SUM(calls) as total_calls,
                SUM(total_exec_time) as total_exec_time,
                AVG(mean_exec_time) as mean_exec_time,
                SUM(rows) as total_rows
         FROM query_stats
         WHERE timestamp >= ? AND timestamp <= ?
         GROUP BY queryid
         ORDER BY ${orderCol} DESC
         LIMIT ?`
      )
      .all(startMs, endMs, limit) as TopQuery[];
  }

  prune(retentionMs?: number): number {
    const cutoff = Date.now() - (retentionMs ?? this.retentionMs);
    const info = this.db.prepare("DELETE FROM query_stats WHERE timestamp < ?").run(cutoff);
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}
