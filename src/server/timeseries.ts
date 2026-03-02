import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DEFAULT_DIR = path.join(os.homedir(), ".pg-dash");
const DEFAULT_RETENTION_DAYS = 7;

export interface DataPoint {
  timestamp: number;
  metric: string;
  value: number;
}

export class TimeseriesStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private retentionMs: number;

  constructor(dataDir?: string, retentionDays = DEFAULT_RETENTION_DAYS) {
    const dir = dataDir || DEFAULT_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "metrics.db");
    this.db = new Database(dbPath);
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        timestamp INTEGER NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_metric_ts ON metrics(metric, timestamp);
    `);

    this.insertStmt = this.db.prepare(
      "INSERT INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)"
    );
  }

  insert(metric: string, value: number, timestamp?: number): void {
    this.insertStmt.run(timestamp ?? Date.now(), metric, value);
  }

  insertMany(points: DataPoint[]): void {
    const tx = this.db.transaction((pts: DataPoint[]) => {
      for (const p of pts) {
        this.insertStmt.run(p.timestamp, p.metric, p.value);
      }
    });
    tx(points);
  }

  query(metric: string, startMs: number, endMs?: number): { timestamp: number; value: number }[] {
    const end = endMs ?? Date.now();
    return this.db
      .prepare(
        "SELECT timestamp, value FROM metrics WHERE metric = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp"
      )
      .all(metric, startMs, end) as { timestamp: number; value: number }[];
  }

  latest(metrics?: string[]): Record<string, { timestamp: number; value: number }> {
    const result: Record<string, { timestamp: number; value: number }> = {};
    if (metrics && metrics.length > 0) {
      const placeholders = metrics.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT m.metric, m.timestamp, m.value FROM metrics m INNER JOIN (SELECT metric, MAX(timestamp) as max_ts FROM metrics WHERE metric IN (${placeholders}) GROUP BY metric) g ON m.metric = g.metric AND m.timestamp = g.max_ts`
        )
        .all(...metrics) as DataPoint[];
      for (const r of rows) result[r.metric] = { timestamp: r.timestamp, value: r.value };
    } else {
      const rows = this.db
        .prepare(
          "SELECT m.metric, m.timestamp, m.value FROM metrics m INNER JOIN (SELECT metric, MAX(timestamp) as max_ts FROM metrics GROUP BY metric) g ON m.metric = g.metric AND m.timestamp = g.max_ts"
        )
        .all() as DataPoint[];
      for (const r of rows) result[r.metric] = { timestamp: r.timestamp, value: r.value };
    }
    return result;
  }

  prune(): number {
    const cutoff = Date.now() - this.retentionMs;
    const info = this.db.prepare("DELETE FROM metrics WHERE timestamp < ?").run(cutoff);
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}
