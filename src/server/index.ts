import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getOverview } from "./queries/overview.js";
import { getHealth } from "./queries/health.js";
import { getDatabases } from "./queries/databases.js";
import { getTables } from "./queries/tables.js";
import { getActivity } from "./queries/activity.js";
import { getSlowQueries } from "./queries/slow-queries.js";
import { getAdvisorReport, isSafeFix } from "./advisor.js";
import { getSchemaTables, getSchemaTableDetail, getSchemaIndexes, getSchemaFunctions, getSchemaExtensions, getSchemaEnums } from "./queries/schema.js";
import { TimeseriesStore } from "./timeseries.js";
import { Collector } from "./collector.js";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RANGE_MAP: Record<string, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

interface ServerOptions {
  connectionString: string;
  port: number;
  open: boolean;
  json: boolean;
  dataDir?: string;
  interval?: number;
}

export async function startServer(opts: ServerOptions) {
  const pool = new Pool({ connectionString: opts.connectionString });

  // Test connection
  try {
    const client = await pool.connect();
    client.release();
  } catch (err: any) {
    console.error(`Failed to connect to PostgreSQL: ${err.message}`);
    process.exit(1);
  }

  // JSON mode: dump health and exit
  if (opts.json) {
    try {
      const [overview, health, databases, tables] = await Promise.all([
        getOverview(pool),
        getHealth(pool),
        getDatabases(pool),
        getTables(pool),
      ]);
      console.log(JSON.stringify({ overview, health, databases, tables }, null, 2));
    } catch (err: any) {
      console.error(JSON.stringify({ error: err.message }));
      process.exit(1);
    }
    await pool.end();
    process.exit(0);
  }

  // Initialize time-series store and collector
  const store = new TimeseriesStore(opts.dataDir);
  const intervalMs = (opts.interval || 30) * 1000;
  const collector = new Collector(pool, store, intervalMs);

  console.log(`  Collecting metrics every ${(intervalMs / 1000)}s...`);
  collector.start();

  const app = new Hono();

  // Phase 0 endpoints
  app.get("/api/overview", async (c) => {
    try { return c.json(await getOverview(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/health", async (c) => {
    try { return c.json(await getHealth(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/databases", async (c) => {
    try { return c.json(await getDatabases(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/tables", async (c) => {
    try { return c.json(await getTables(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  // Phase 1 endpoints
  app.get("/api/metrics", (c) => {
    try {
      const metric = c.req.query("metric");
      const range = c.req.query("range") || "1h";
      if (!metric) return c.json({ error: "metric param required" }, 400);
      const rangeMs = RANGE_MAP[range] || RANGE_MAP["1h"];
      const now = Date.now();
      const data = store.query(metric, now - rangeMs, now);
      return c.json(data);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/metrics/latest", (_c) => {
    try {
      const snapshot = collector.getLastSnapshot();
      return _c.json(snapshot);
    } catch (err: any) {
      return _c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/activity", async (c) => {
    try { return c.json(await getActivity(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/queries", async (c) => {
    try { return c.json(await getSlowQueries(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/activity/:pid/cancel", async (c) => {
    try {
      const pid = parseInt(c.req.param("pid"));
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_cancel_backend($1)", [pid]);
        return c.json({ ok: true });
      } finally {
        client.release();
      }
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Phase 2 endpoints

  app.get("/api/advisor", async (c) => {
    try { return c.json(await getAdvisorReport(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/fix", async (c) => {
    try {
      const body = await c.req.json();
      const sql = body?.sql?.trim();
      if (!sql) return c.json({ error: "sql field required" }, 400);
      if (!isSafeFix(sql)) return c.json({ error: "Operation not allowed. Only VACUUM, ANALYZE, REINDEX, CREATE/DROP INDEX CONCURRENTLY, pg_terminate_backend, pg_cancel_backend, and EXPLAIN ANALYZE are permitted." }, 403);
      const client = await pool.connect();
      try {
        const start = Date.now();
        const result = await client.query(sql);
        const duration = Date.now() - start;
        return c.json({ ok: true, duration, rowCount: result.rowCount, rows: result.rows || [] });
      } finally {
        client.release();
      }
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/schema/tables", async (c) => {
    try { return c.json(await getSchemaTables(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/schema/tables/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const detail = await getSchemaTableDetail(pool, name);
      if (!detail) return c.json({ error: "Table not found" }, 404);
      return c.json(detail);
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/schema/indexes", async (c) => {
    try { return c.json(await getSchemaIndexes(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/schema/functions", async (c) => {
    try { return c.json(await getSchemaFunctions(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/schema/extensions", async (c) => {
    try { return c.json(await getSchemaExtensions(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/schema/enums", async (c) => {
    try { return c.json(await getSchemaEnums(pool)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  // Serve frontend
  const uiPath = path.resolve(__dirname, "ui");
  app.use("/*", serveStatic({ root: uiPath }));
  app.get("/*", serveStatic({ root: uiPath, path: "index.html" }));

  // Create HTTP server + WebSocket server
  const server = http.createServer((req, res) => {
    // Let Hono handle HTTP
    const url = new URL(req.url || "/", `http://localhost:${opts.port}`);
    const request = new Request(url.toString(), {
      method: req.method,
      headers: req.headers as any,
    });
    app.fetch(request).then((response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      response.arrayBuffer().then((buf) => {
        res.end(Buffer.from(buf));
      });
    }).catch(() => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    // Send latest snapshot immediately
    const snap = collector.getLastSnapshot();
    if (Object.keys(snap).length > 0) {
      ws.send(JSON.stringify({ type: "metrics", data: snap }));
    }
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  // Broadcast metrics and activity on each collection
  const origCollect = collector.collect.bind(collector);
  collector.collect = async () => {
    const snapshot = await origCollect();
    if (clients.size > 0 && Object.keys(snapshot).length > 0) {
      const metricsMsg = JSON.stringify({ type: "metrics", data: snapshot });
      // Also get activity
      let activityData: any[] = [];
      try { activityData = await getActivity(pool); } catch {}
      const activityMsg = JSON.stringify({ type: "activity", data: activityData });
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(metricsMsg);
          ws.send(activityMsg);
        }
      }
    }
    return snapshot;
  };

  server.listen(opts.port, async () => {
    console.log(`\n  pg-dash running at http://localhost:${opts.port}\n`);
    if (opts.open) {
      try {
        const openMod = await import("open");
        await openMod.default(`http://localhost:${opts.port}`);
      } catch {}
    }
  });

  // Keep process alive
  await new Promise(() => {});
}
