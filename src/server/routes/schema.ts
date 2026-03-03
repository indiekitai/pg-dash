import type { Hono } from "hono";
import type { Pool } from "pg";
import type { SchemaTracker } from "../schema-tracker.js";
import { getSchemaTables, getSchemaTableDetail, getSchemaIndexes, getSchemaFunctions, getSchemaExtensions, getSchemaEnums } from "../queries/schema.js";

export function registerSchemaRoutes(app: Hono, pool: Pool, schemaTracker: SchemaTracker) {
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

  // Schema change tracking endpoints
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
}
