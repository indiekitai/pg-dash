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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ServerOptions {
  connectionString: string;
  port: number;
  open: boolean;
  json: boolean;
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

  const app = new Hono();

  app.get("/api/overview", async (c) => {
    try {
      return c.json(await getOverview(pool));
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/health", async (c) => {
    try {
      return c.json(await getHealth(pool));
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/databases", async (c) => {
    try {
      return c.json(await getDatabases(pool));
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/tables", async (c) => {
    try {
      return c.json(await getTables(pool));
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Serve frontend
  const uiPath = path.resolve(__dirname, "ui");
  app.use("/*", serveStatic({ root: uiPath }));
  app.get("/*", serveStatic({ root: uiPath, path: "index.html" }));

  console.log(`\n  pg-dash running at http://localhost:${opts.port}\n`);

  serve({ fetch: app.fetch, port: opts.port });

  if (opts.open) {
    try {
      const openMod = await import("open");
      await openMod.default(`http://localhost:${opts.port}`);
    } catch {}
  }
}
