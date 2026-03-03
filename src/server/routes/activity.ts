import type { Hono } from "hono";
import type { Pool } from "pg";
import { getActivity } from "../queries/activity.js";
import { getSlowQueries } from "../queries/slow-queries.js";

export function registerActivityRoutes(app: Hono, pool: Pool) {
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
}
