// Schema Tracker — takes schema snapshots, stores in SQLite, detects changes

import type { Pool } from "pg";
import type Database from "better-sqlite3";
import { getSchemaTables, getSchemaTableDetail, getSchemaEnums } from "./queries/schema.js";
import { diffSnapshots, type SchemaSnapshot, type SchemaChange } from "./schema-diff.js";

/** Build a full schema snapshot from a live pool — reusable for env comparison */
export async function buildLiveSnapshot(pool: Pool): Promise<SchemaSnapshot> {
  const tables = await getSchemaTables(pool);
  const enums = await getSchemaEnums(pool);

  const detailedTables = await Promise.all(
    tables.map(async (t: any) => {
      const detail = await getSchemaTableDetail(pool, `${t.schema}.${t.name}`);
      if (!detail) return null;
      return {
        name: detail.name,
        schema: detail.schema,
        columns: detail.columns.map((c: any) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          default_value: c.default_value,
        })),
        indexes: detail.indexes.map((i: any) => ({
          name: i.name,
          definition: i.definition,
          is_unique: i.is_unique,
          is_primary: i.is_primary,
        })),
        constraints: detail.constraints.map((c: any) => ({
          name: c.name,
          type: c.type,
          definition: c.definition,
        })),
      };
    })
  );

  return {
    tables: detailedTables.filter(Boolean) as SchemaSnapshot["tables"],
    enums: enums.map((e: any) => ({ name: e.name, schema: e.schema, values: e.values })),
  };
}

export class SchemaTracker {
  private db: Database.Database;
  private pool: Pool;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database.Database, pool: Pool, intervalMs = 6 * 60 * 60 * 1000) {
    this.db = db;
    this.pool = pool;
    this.intervalMs = intervalMs;
    this.initTables();
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        change_type TEXT NOT NULL,
        object_type TEXT NOT NULL,
        table_name TEXT,
        detail TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES schema_snapshots(id)
      );
    `);
  }

  async takeSnapshot(): Promise<{ snapshotId: number; changes: SchemaChange[] }> {
    const snapshot = await this.buildSnapshot();
    const now = Date.now();
    const json = JSON.stringify(snapshot);

    const info = this.db.prepare("INSERT INTO schema_snapshots (timestamp, snapshot) VALUES (?, ?)").run(now, json);
    const snapshotId = Number(info.lastInsertRowid);

    // Diff against previous
    const prev = this.db.prepare("SELECT snapshot FROM schema_snapshots WHERE id < ? ORDER BY id DESC LIMIT 1").get(snapshotId) as { snapshot: string } | undefined;
    let changes: SchemaChange[] = [];
    if (prev) {
      const oldSnap: SchemaSnapshot = JSON.parse(prev.snapshot);
      changes = diffSnapshots(oldSnap, snapshot);
      if (changes.length > 0) {
        const insert = this.db.prepare("INSERT INTO schema_changes (snapshot_id, timestamp, change_type, object_type, table_name, detail) VALUES (?, ?, ?, ?, ?, ?)");
        const tx = this.db.transaction((chs: SchemaChange[]) => {
          for (const c of chs) {
            insert.run(snapshotId, now, c.change_type, c.object_type, c.table_name, c.detail);
          }
        });
        tx(changes);
      }
    }

    return { snapshotId, changes };
  }

  private async buildSnapshot(): Promise<SchemaSnapshot> {
    return buildLiveSnapshot(this.pool);
  }

  start() {
    // Take initial snapshot
    this.takeSnapshot().catch((err) => console.error("Schema snapshot error:", err.message));
    this.timer = setInterval(() => {
      this.takeSnapshot().catch((err) => console.error("Schema snapshot error:", err.message));
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // API helpers
  getHistory(limit = 30) {
    return this.db.prepare("SELECT id, timestamp FROM schema_snapshots ORDER BY id DESC LIMIT ?").all(limit);
  }

  getChanges(since?: number) {
    if (since) {
      return this.db.prepare("SELECT * FROM schema_changes WHERE timestamp >= ? ORDER BY timestamp DESC").all(since);
    }
    return this.db.prepare("SELECT * FROM schema_changes ORDER BY timestamp DESC LIMIT 100").all();
  }

  getLatestChanges() {
    const latest = this.db.prepare("SELECT id FROM schema_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    if (!latest) return [];
    return this.db.prepare("SELECT * FROM schema_changes WHERE snapshot_id = ? ORDER BY id").all(latest.id);
  }

  getDiff(fromId: number, toId: number) {
    const from = this.db.prepare("SELECT snapshot FROM schema_snapshots WHERE id = ?").get(fromId) as { snapshot: string } | undefined;
    const to = this.db.prepare("SELECT snapshot FROM schema_snapshots WHERE id = ?").get(toId) as { snapshot: string } | undefined;
    if (!from || !to) return null;
    return diffSnapshots(JSON.parse(from.snapshot), JSON.parse(to.snapshot));
  }
}
