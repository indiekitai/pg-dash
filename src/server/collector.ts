import type { Pool } from "pg";
import type { TimeseriesStore } from "./timeseries.js";

export const ALL_METRICS = [
  "connections_active",
  "connections_idle",
  "connections_total",
  "tps_commit",
  "tps_rollback",
  "cache_hit_ratio",
  "deadlocks",
  "temp_bytes",
  "db_size_bytes",
  "tuple_inserted",
  "tuple_updated",
  "tuple_deleted",
  "replication_lag_bytes",
] as const;

export type MetricName = (typeof ALL_METRICS)[number];

interface CumulativeState {
  timestamp: number;
  xact_commit: number;
  xact_rollback: number;
  deadlocks: number;
  temp_bytes: number;
  tup_inserted: number;
  tup_updated: number;
  tup_deleted: number;
}

export class Collector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: CumulativeState | null = null;
  private lastSnapshot: Record<string, number> = {};

  constructor(
    private pool: Pool,
    private store: TimeseriesStore,
    private intervalMs: number = 30000
  ) {}

  start(): void {
    this.collect().catch(err => console.error("[collector] Initial collection failed:", err));
    this.timer = setInterval(() => {
      this.collect().catch(err => console.error("[collector] Collection failed:", err));
    }, this.intervalMs);
    // Prune once per hour
    setInterval(() => this.store.prune(), 60 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLastSnapshot(): Record<string, number> {
    return { ...this.lastSnapshot };
  }

  async collect(): Promise<Record<string, number>> {
    const now = Date.now();
    const snapshot: Record<string, number> = {};

    try {
      const client = await this.pool.connect();
      try {
        // Connections
        const connRes = await client.query(`
          SELECT
            count(*) FILTER (WHERE state = 'active')::int AS active,
            count(*) FILTER (WHERE state = 'idle')::int AS idle,
            count(*)::int AS total
          FROM pg_stat_activity
        `);
        const conn = connRes.rows[0];
        snapshot.connections_active = conn.active;
        snapshot.connections_idle = conn.idle;
        snapshot.connections_total = conn.total;

        // Database stats (cumulative counters + cache ratio + size)
        const dbRes = await client.query(`
          SELECT
            xact_commit, xact_rollback, deadlocks, temp_bytes,
            tup_inserted, tup_updated, tup_deleted,
            CASE WHEN (blks_hit + blks_read) = 0 THEN 1
              ELSE blks_hit::float / (blks_hit + blks_read) END AS cache_ratio,
            pg_database_size(current_database()) AS db_size
          FROM pg_stat_database WHERE datname = current_database()
        `);
        const db = dbRes.rows[0];
        if (db) {
          snapshot.cache_hit_ratio = parseFloat(db.cache_ratio);
          snapshot.db_size_bytes = parseInt(db.db_size);

          const cur: CumulativeState = {
            timestamp: now,
            xact_commit: parseInt(db.xact_commit),
            xact_rollback: parseInt(db.xact_rollback),
            deadlocks: parseInt(db.deadlocks),
            temp_bytes: parseInt(db.temp_bytes),
            tup_inserted: parseInt(db.tup_inserted),
            tup_updated: parseInt(db.tup_updated),
            tup_deleted: parseInt(db.tup_deleted),
          };

          if (this.prev) {
            const dtSec = (now - this.prev.timestamp) / 1000;
            if (dtSec > 0) {
              snapshot.tps_commit = Math.max(0, (cur.xact_commit - this.prev.xact_commit) / dtSec);
              snapshot.tps_rollback = Math.max(0, (cur.xact_rollback - this.prev.xact_rollback) / dtSec);
              snapshot.deadlocks = Math.max(0, cur.deadlocks - this.prev.deadlocks);
              snapshot.temp_bytes = Math.max(0, cur.temp_bytes - this.prev.temp_bytes);
              snapshot.tuple_inserted = Math.max(0, (cur.tup_inserted - this.prev.tup_inserted) / dtSec);
              snapshot.tuple_updated = Math.max(0, (cur.tup_updated - this.prev.tup_updated) / dtSec);
              snapshot.tuple_deleted = Math.max(0, (cur.tup_deleted - this.prev.tup_deleted) / dtSec);
            }
          }
          this.prev = cur;
        }

        // Replication lag
        try {
          const repRes = await client.query(`
            SELECT CASE WHEN pg_is_in_recovery() 
              THEN pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())
              ELSE 0 END AS lag_bytes
          `);
          snapshot.replication_lag_bytes = parseInt(repRes.rows[0]?.lag_bytes ?? "0");
        } catch {
          snapshot.replication_lag_bytes = 0;
        }
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[collector] Error collecting metrics:", (err as Error).message);
      return snapshot;
    }

    // Store to SQLite
    const points = Object.entries(snapshot).map(([metric, value]) => ({
      timestamp: now,
      metric,
      value,
    }));
    if (points.length > 0) {
      this.store.insertMany(points);
    }

    this.lastSnapshot = snapshot;
    return snapshot;
  }
}
