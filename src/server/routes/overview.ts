import type { Hono } from "hono";
import type { Pool } from "pg";
import { getOverview } from "../queries/overview.js";
import { getDatabases } from "../queries/databases.js";
import { getTables } from "../queries/tables.js";

export function registerOverviewRoutes(app: Hono, pool: Pool) {
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
}
