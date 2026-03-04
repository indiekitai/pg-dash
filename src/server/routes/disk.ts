import type { Hono } from "hono";
import type { Pool } from "pg";
import type { TimeseriesStore } from "../timeseries.js";
import { DiskPredictor } from "../disk-prediction.js";

const RANGE_MAP: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function registerDiskRoutes(app: Hono, pool: Pool, store: TimeseriesStore) {
  const predictor = new DiskPredictor();

  app.get("/api/disk/usage", async (c) => {
    try {
      const client = await pool.connect();
      try {
        // Database size + data directory
        const dbRes = await client.query(`
          SELECT pg_database_size(current_database()) AS db_size,
                 (SELECT setting FROM pg_settings WHERE name = 'data_directory') AS data_dir
        `);
        const { db_size, data_dir } = dbRes.rows[0];

        // Tablespace sizes (safe: only where user has access)
        const tsRes = await client.query(`
          SELECT spcname,
            CASE WHEN has_tablespace_privilege(spcname, 'CREATE')
              THEN pg_tablespace_size(oid) ELSE NULL END AS size
          FROM pg_tablespace
        `);
        const tablespaces = tsRes.rows
          .filter((r: any) => r.size !== null)
          .map((r: any) => ({
            name: r.spcname,
            size: parseInt(r.size),
          }));

        // Top 20 largest tables
        const tableRes = await client.query(`
          SELECT schemaname, relname,
                 pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as total_size,
                 pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as table_size,
                 pg_indexes_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as index_size
          FROM pg_stat_user_tables
          ORDER BY pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) DESC
          LIMIT 20
        `);
        const tables = tableRes.rows.map((r: any) => ({
          schema: r.schemaname,
          name: r.relname,
          totalSize: parseInt(r.total_size),
          tableSize: parseInt(r.table_size),
          indexSize: parseInt(r.index_size),
        }));

        return c.json({
          dbSize: parseInt(db_size),
          dataDir: data_dir,
          tablespaces,
          tables,
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/disk/prediction", async (c) => {
    try {
      const days = parseInt(c.req.query("days") || "30");
      const maxDisk = c.req.query("maxDisk") ? parseInt(c.req.query("maxDisk")!) : undefined;
      const prediction = predictor.predict(store, "db_size_bytes", days, maxDisk);
      return c.json({ prediction });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/disk/table-history/:table", async (c) => {
    try {
      const table = c.req.param("table");
      const range = c.req.query("range") || "24h";
      const rangeMs = RANGE_MAP[range] || RANGE_MAP["24h"];
      const now = Date.now();
      const data = store.query(`table_size:${table}`, now - rangeMs, now);
      return c.json(data);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/disk/history", async (c) => {
    try {
      const range = c.req.query("range") || "24h";
      const rangeMs = RANGE_MAP[range] || RANGE_MAP["24h"];
      const now = Date.now();
      const data = store.query("db_size_bytes", now - rangeMs, now);
      return c.json(data);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}
