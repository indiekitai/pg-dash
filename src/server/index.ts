import { Hono } from "hono";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getOverview } from "./queries/overview.js";
import { getDatabases } from "./queries/databases.js";
import { getTables } from "./queries/tables.js";
import { getActivity } from "./queries/activity.js";
import { getSlowQueries } from "./queries/slow-queries.js";
import { getAdvisorReport, isSafeFix } from "./advisor.js";
import { getSchemaTables, getSchemaTableDetail, getSchemaIndexes, getSchemaFunctions, getSchemaExtensions, getSchemaEnums } from "./queries/schema.js";
import { TimeseriesStore } from "./timeseries.js";
import { Collector } from "./collector.js";
import { SchemaTracker } from "./schema-tracker.js";
import { AlertManager } from "./alerts.js";
import Database from "better-sqlite3";
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
      const [overview, advisor, databases, tables] = await Promise.all([
        getOverview(pool),
        getAdvisorReport(pool),
        getDatabases(pool),
        getTables(pool),
      ]);
      console.log(JSON.stringify({ overview, advisor, databases, tables }, null, 2));
    } catch (err: any) {
      console.error(JSON.stringify({ error: err.message }));
      process.exit(1);
    }
    await pool.end();
    process.exit(0);
  }

  const dataDir = opts.dataDir || path.join(os.homedir(), ".pg-dash");
  fs.mkdirSync(dataDir, { recursive: true });

  // Initialize time-series store and collector
  const store = new TimeseriesStore(opts.dataDir);
  const intervalMs = (opts.interval || 30) * 1000;
  const collector = new Collector(pool, store, intervalMs);

  console.log(`  Collecting metrics every ${(intervalMs / 1000)}s...`);
  collector.start();

  // Initialize schema tracker
  const schemaDbPath = path.join(dataDir, "schema.db");
  const schemaDb = new Database(schemaDbPath);
  schemaDb.pragma("journal_mode = WAL");
  const schemaTracker = new SchemaTracker(schemaDb, pool);
  schemaTracker.start();
  console.log("  Schema change tracking enabled");

  // Initialize alerts
  const alertsDbPath = path.join(dataDir, "alerts.db");
  const alertsDb = new Database(alertsDbPath);
  alertsDb.pragma("journal_mode = WAL");
  const alertManager = new AlertManager(alertsDb);
  console.log("  Alert monitoring enabled");

  const app = new Hono();

  // Phase 0 endpoints
  app.get("/api/overview", async (c) => {
    try { return c.json(await getOverview(pool)); }
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

  // Phase 3: Schema change tracking endpoints
  app.get("/api/schema/history", (c) => {
    try {
      const limit = parseInt(c.req.query("limit") || "30");
      return c.json(schemaTracker.getHistory(limit));
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/schema/changes", (c) => {
    try {
      const since = c.req.query("since");
      return c.json(schemaTracker.getChanges(since ? parseInt(since) : undefined));
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/schema/changes/latest", (c) => {
    try { return c.json(schemaTracker.getLatestChanges()); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/schema/diff", (c) => {
    try {
      const from = parseInt(c.req.query("from") || "0");
      const to = parseInt(c.req.query("to") || "0");
      if (!from || !to) return c.json({ error: "from and to params required" }, 400);
      const diff = schemaTracker.getDiff(from, to);
      if (!diff) return c.json({ error: "Snapshot not found" }, 404);
      return c.json(diff);
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/schema/snapshot", async (c) => {
    try {
      const result = await schemaTracker.takeSnapshot();
      return c.json(result);
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  // Phase 4: Alerts endpoints
  app.get("/api/alerts/rules", (c) => {
    try { return c.json(alertManager.getRules()); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/alerts/rules", async (c) => {
    try {
      const body = await c.req.json();
      const rule = alertManager.addRule(body);
      return c.json(rule, 201);
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.put("/api/alerts/rules/:id", async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const body = await c.req.json();
      const ok = alertManager.updateRule(id, body);
      if (!ok) return c.json({ error: "Rule not found" }, 404);
      return c.json({ ok: true });
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.delete("/api/alerts/rules/:id", (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const ok = alertManager.deleteRule(id);
      if (!ok) return c.json({ error: "Rule not found" }, 404);
      return c.json({ ok: true });
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/alerts/history", (c) => {
    try {
      const limit = parseInt(c.req.query("limit") || "50");
      return c.json(alertManager.getHistory(limit));
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  // Serve frontend
  const uiPath = path.resolve(__dirname, "ui");
  const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  app.get("/*", async (c) => {
    const urlPath = c.req.path === "/" ? "/index.html" : c.req.path;
    const filePath = path.join(uiPath, urlPath);
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      return new Response(content, { headers: { "content-type": contentType } });
    } catch {
      // SPA fallback
      const html = fs.readFileSync(path.join(uiPath, "index.html"));
      return new Response(html, { headers: { "content-type": "text/html" } });
    }
  });

  // Create HTTP server + WebSocket server
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const url = new URL(req.url || "/", `http://localhost:${opts.port}`);
    const init: RequestInit = {
      method: req.method,
      headers: req.headers as any,
    };
    if (req.method !== "GET" && req.method !== "HEAD" && body.length > 0) {
      init.body = body;
    }
    const request = new Request(url.toString(), init);
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
    const snap = collector.getLastSnapshot();
    if (Object.keys(snap).length > 0) {
      ws.send(JSON.stringify({ type: "metrics", data: snap }));
    }
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  // Broadcast metrics, activity, and check alerts on each collection
  const origCollect = collector.collect.bind(collector);
  collector.collect = async () => {
    const snapshot = await origCollect();
    if (clients.size > 0 && Object.keys(snapshot).length > 0) {
      const metricsMsg = JSON.stringify({ type: "metrics", data: snapshot });
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

    // Check alerts after each collection
    if (Object.keys(snapshot).length > 0) {
      try {
        // Derive alert metrics from raw snapshot
        const alertMetrics: Record<string, number> = {};

        // Connection utilization (percentage)
        if (snapshot.connections_total !== undefined) {
          const client = await pool.connect();
          try {
            const r = await client.query("SELECT setting::int AS max FROM pg_settings WHERE name = 'max_connections'");
            const max = r.rows[0]?.max || 100;
            alertMetrics.connection_util = (snapshot.connections_total / max) * 100;
          } finally { client.release(); }
        }

        // Cache hit ratio as percentage
        if (snapshot.cache_hit_ratio !== undefined) {
          alertMetrics.cache_hit_pct = snapshot.cache_hit_ratio * 100;
        }

        // Long-running queries count
        try {
          const client = await pool.connect();
          try {
            const r = await client.query("SELECT count(*)::int AS c FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '5 minutes' AND pid != pg_backend_pid()");
            alertMetrics.long_query_count = r.rows[0]?.c || 0;
          } finally { client.release(); }
        } catch {}

        // Idle in transaction count
        try {
          const client = await pool.connect();
          try {
            const r = await client.query("SELECT count(*)::int AS c FROM pg_stat_activity WHERE state = 'idle in transaction' AND now() - state_change > interval '10 minutes'");
            alertMetrics.idle_in_tx_count = r.rows[0]?.c || 0;
          } finally { client.release(); }
        } catch {}

        // Health score (computed less frequently - only if we already have advisor data)
        // We'll check it periodically (don't want to run full advisor every 30s)
        // Simple approach: check on every 10th collection
        if (Math.random() < 0.1) {
          try {
            const report = await getAdvisorReport(pool);
            alertMetrics.health_score = report.score;
          } catch {}
        }

        const fired = alertManager.checkAlerts(alertMetrics);

        // Broadcast fired alerts to WebSocket clients
        if (fired.length > 0 && clients.size > 0) {
          const alertMsg = JSON.stringify({ type: "alerts", data: fired });
          for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(alertMsg);
            }
          }
        }
      } catch (err) {
        console.error("[alerts] Error checking alerts:", (err as Error).message);
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

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n  Shutting down gracefully...");
    collector.stop();
    schemaTracker.stop();
    wss.close();
    server.close();
    store.close();
    schemaDb.close();
    alertsDb.close();
    await pool.end();
    console.log("  Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}
