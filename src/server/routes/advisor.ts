import type { Hono } from "hono";
import type { Pool } from "pg";
import { getAdvisorReport, isSafeFix, getIgnoredIssues, ignoreIssue, unignoreIssue } from "../advisor.js";

export function registerAdvisorRoutes(app: Hono, pool: Pool, longQueryThreshold: number) {
  app.get("/api/advisor", async (c) => {
    try { return c.json(await getAdvisorReport(pool, longQueryThreshold)); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/advisor/ignored", (c) => {
    try { return c.json(getIgnoredIssues()); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/advisor/ignore", async (c) => {
    try {
      const body = await c.req.json();
      const issueId = body?.issueId;
      if (!issueId) return c.json({ error: "issueId required" }, 400);
      ignoreIssue(issueId);
      return c.json({ ok: true });
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.delete("/api/advisor/ignore/:issueId", (c) => {
    try {
      const issueId = c.req.param("issueId");
      unignoreIssue(issueId);
      return c.json({ ok: true });
    } catch (err: any) { return c.json({ error: err.message }, 500); }
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
}
