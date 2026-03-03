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
import { getAdvisorReport } from "./advisor.js";
import { TimeseriesStore } from "./timeseries.js";
import { Collector } from "./collector.js";
import { SchemaTracker } from "./schema-tracker.js";
import { AlertManager } from "./alerts.js";
import { registerOverviewRoutes } from "./routes/overview.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerAdvisorRoutes } from "./routes/advisor.js";
import { registerSchemaRoutes } from "./routes/schema.js";
import { registerAlertsRoutes } from "./routes/alerts.js";
import { registerExplainRoutes } from "./routes/explain.js";
import { registerDiskRoutes } from "./routes/disk.js";
import { QueryStatsStore } from "./query-stats.js";
import { registerQueryStatsRoutes } from "./routes/query-stats.js";
import { registerExportRoutes } from "./routes/export.js";
import { DiskPredictor } from "./disk-prediction.js";
import Database from "better-sqlite3";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ServerOptions {
  connectionString: string;
  port: number;
  bind?: string;
  open: boolean;
  json: boolean;
  dataDir?: string;
  interval?: number;
  retentionDays?: number;
  snapshotInterval?: number;
  queryStatsInterval?: number;
  longQueryThreshold?: number;
  auth?: string;
  token?: string;
  webhook?: string;
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

  const longQueryThreshold = opts.longQueryThreshold || 5;
  const diskPredictor = new DiskPredictor();

  // JSON mode: dump health and exit
  if (opts.json) {
    try {
      const [overview, advisor, databases, tables] = await Promise.all([
        getOverview(pool),
        getAdvisorReport(pool, longQueryThreshold),
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

  // Initialize shared metrics database
  const metricsDbPath = path.join(dataDir, "metrics.db");
  const metricsDb = new Database(metricsDbPath);
  metricsDb.pragma("journal_mode = WAL");

  // Initialize time-series store and collector
  const store = new TimeseriesStore(metricsDb, opts.retentionDays);
  const intervalMs = (opts.interval || 30) * 1000;
  const collector = new Collector(pool, store, intervalMs);

  console.log(`  Collecting metrics every ${(intervalMs / 1000)}s...`);
  collector.start();

  // Initialize schema tracker
  const schemaDbPath = path.join(dataDir, "schema.db");
  const schemaDb = new Database(schemaDbPath);
  schemaDb.pragma("journal_mode = WAL");
  const snapshotIntervalMs = (opts.snapshotInterval || 6) * 60 * 60 * 1000;
  const schemaTracker = new SchemaTracker(schemaDb, pool, snapshotIntervalMs);
  schemaTracker.start();
  console.log("  Schema change tracking enabled");

  // Initialize alerts
  const alertsDbPath = path.join(dataDir, "alerts.db");
  const alertsDb = new Database(alertsDbPath);
  alertsDb.pragma("journal_mode = WAL");
  const alertManager = new AlertManager(alertsDb, opts.webhook);
  console.log("  Alert monitoring enabled");

  // Initialize query stats store (shares metricsDb)
  const queryStatsStore = new QueryStatsStore(metricsDb, opts.retentionDays);
  const querySnapshotIntervalMs = (opts.queryStatsInterval || 5) * 60 * 1000;
  queryStatsStore.startPeriodicSnapshot(pool, querySnapshotIntervalMs);
  console.log(`  Query stats snapshots every ${querySnapshotIntervalMs / 60000}m`);

  const app = new Hono();

  // Auth endpoint for cookie-based auth (must be before auth middleware)
  if (opts.token) {
    app.post("/api/auth", async (c) => {
      try {
        const body = await c.req.json();
        if (body?.token === opts.token) {
          c.header("Set-Cookie", `pg-dash-token=${opts.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
          return c.json({ ok: true });
        }
        return c.json({ error: "Invalid token" }, 401);
      } catch {
        return c.json({ error: "Invalid request" }, 400);
      }
    });
  }

  // Auth middleware
  if (opts.auth || opts.token) {
    app.use("*", async (c, next) => {
      const authHeader = c.req.header("authorization") || "";
      if (opts.token) {
        if (authHeader === `Bearer ${opts.token}`) return next();
      }
      if (opts.auth) {
        const [user, pass] = opts.auth.split(":");
        const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
        if (authHeader === expected) return next();
      }
      // Check query param token for WebSocket upgrade compatibility
      const url = new URL(c.req.url, "http://localhost");
      if (opts.token && url.searchParams.get("token") === opts.token) return next();

      // Check cookie for token auth
      if (opts.token) {
        const cookies = c.req.header("cookie") || "";
        const match = cookies.match(/(?:^|;\s*)pg-dash-token=([^;]*)/);
        if (match && match[1] === opts.token) return next();
      }

      if (opts.auth) {
        c.header("WWW-Authenticate", 'Basic realm="pg-dash"');
      }
      return c.text("Unauthorized", 401);
    });
  }

  // Register route modules
  registerOverviewRoutes(app, pool);
  registerMetricsRoutes(app, store, collector);
  registerActivityRoutes(app, pool);
  registerAdvisorRoutes(app, pool, longQueryThreshold, store);
  registerSchemaRoutes(app, pool, schemaTracker);
  registerAlertsRoutes(app, alertManager);
  registerExplainRoutes(app, pool);
  registerDiskRoutes(app, pool, store);
  registerQueryStatsRoutes(app, queryStatsStore);
  registerExportRoutes(app, pool, longQueryThreshold);

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
      const content = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      return new Response(content, { headers: { "content-type": contentType } });
    } catch {
      // SPA fallback
      try {
        const html = await fs.promises.readFile(path.join(uiPath, "index.html"));
        return new Response(html, { headers: { "content-type": "text/html" } });
      } catch (err) {
        console.error("[static] Error reading index.html:", (err as Error).message);
        return c.text("Not Found", 404);
      }
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

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (opts.auth || opts.token) ? (info, cb) => {
      const url = new URL(info.req.url || "/", `http://localhost:${opts.port}`);
      const qToken = url.searchParams.get("token");
      if (opts.token && qToken === opts.token) return cb(true);

      const authHeader = info.req.headers["authorization"] || "";
      if (opts.token && authHeader === `Bearer ${opts.token}`) return cb(true);
      if (opts.auth) {
        const [user, pass] = opts.auth.split(":");
        const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
        if (authHeader === expected) return cb(true);
      }

      // Check cookie for token auth
      if (opts.token) {
        const cookies = (info.req.headers["cookie"] as string) || "";
        const match = cookies.match(/(?:^|;\s*)pg-dash-token=([^;]*)/);
        if (match && match[1] === opts.token) return cb(true);
      }

      cb(false, 401, "Unauthorized");
    } : undefined,
  });
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
  let collectCycleCount = 0;
  collector.on("collected", async (snapshot: Record<string, number>) => {
    if (clients.size > 0 && Object.keys(snapshot).length > 0) {
      const metricsMsg = JSON.stringify({ type: "metrics", data: snapshot });
      let activityData: any[] = [];
      try { activityData = await getActivity(pool); } catch (err) { console.error("[ws] Error fetching activity:", (err as Error).message); }
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
        const alertMetrics: Record<string, number> = {};

        if (snapshot.connections_total !== undefined) {
          const client = await pool.connect();
          try {
            const r = await client.query("SELECT setting::int AS max FROM pg_settings WHERE name = 'max_connections'");
            const max = r.rows[0]?.max || 100;
            alertMetrics.connection_util = (snapshot.connections_total / max) * 100;
          } finally { client.release(); }
        }

        if (snapshot.cache_hit_ratio !== undefined) {
          alertMetrics.cache_hit_pct = snapshot.cache_hit_ratio * 100;
        }

        try {
          const client = await pool.connect();
          try {
            const r = await client.query(`SELECT count(*)::int AS c FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > $1 * interval '1 minute' AND pid != pg_backend_pid()`, [longQueryThreshold]);
            alertMetrics.long_query_count = r.rows[0]?.c || 0;
          } finally { client.release(); }
        } catch (err) { console.error("[alerts] Error checking long queries:", (err as Error).message); }

        try {
          const client = await pool.connect();
          try {
            const r = await client.query(`SELECT count(*)::int AS c FROM pg_stat_activity WHERE state = 'idle in transaction' AND now() - state_change > $1 * interval '1 minute'`, [longQueryThreshold]);
            alertMetrics.idle_in_tx_count = r.rows[0]?.c || 0;
          } finally { client.release(); }
        } catch (err) { console.error("[alerts] Error checking idle-in-tx:", (err as Error).message); }

        collectCycleCount++;
        if (collectCycleCount % 10 === 0) {
          try {
            const report = await getAdvisorReport(pool, longQueryThreshold);
            alertMetrics.health_score = report.score;
            store.insert("health_score", report.score);
          } catch (err) { console.error("[alerts] Error checking health score:", (err as Error).message); }

          // db_growth_pct_24h
          try {
            if (snapshot.db_size_bytes !== undefined) {
              const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
              const oldData = store.query("db_size_bytes", dayAgo, dayAgo + 5 * 60 * 1000);
              if (oldData.length > 0) {
                const oldVal = oldData[0].value;
                if (oldVal > 0) {
                  alertMetrics.db_growth_pct_24h = ((snapshot.db_size_bytes - oldVal) / oldVal) * 100;
                }
              }
            }
          } catch (err) { console.error("[alerts] Error computing db_growth_pct_24h:", (err as Error).message); }

          // days_until_full
          try {
            const pred = diskPredictor.predict(store, "db_size_bytes", 30);
            if (pred?.daysUntilFull !== null && pred?.daysUntilFull !== undefined) {
              alertMetrics.days_until_full = pred.daysUntilFull;
            }
          } catch (err) { console.error("[alerts] Error computing days_until_full:", (err as Error).message); }
        }

        const fired = alertManager.checkAlerts(alertMetrics);

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
  });

  const bindAddr = opts.bind || "127.0.0.1";
  server.listen(opts.port, bindAddr, async () => {
    console.log(`\n  pg-dash running at http://${bindAddr}:${opts.port}\n`);
    if (opts.open) {
      try {
        const openMod = await import("open");
        await openMod.default(`http://localhost:${opts.port}`);
      } catch (err) { console.error("[open] Failed to open browser:", (err as Error).message); }
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n  Shutting down gracefully...");
    collector.stop();
    schemaTracker.stop();
    queryStatsStore.stop();
    wss.close();
    server.close();
    metricsDb.close();
    schemaDb.close();
    alertsDb.close();
    await pool.end();
    console.log("  Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}
