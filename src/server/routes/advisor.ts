import type { Hono } from "hono";
import type { Pool } from "pg";
import type { TimeseriesStore } from "../timeseries.js";
import { getAdvisorReport, isSafeFix, getIgnoredIssues, ignoreIssue, unignoreIssue } from "../advisor.js";

const RANGE_MAP: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function registerAdvisorRoutes(app: Hono, pool: Pool, longQueryThreshold: number, store?: TimeseriesStore) {
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

  app.get("/api/advisor/history", (c) => {
    if (!store) return c.json([]);
    try {
      const range = c.req.query("range") || "24h";
      const rangeMs = RANGE_MAP[range] || RANGE_MAP["24h"];
      const now = Date.now();
      const data = store.query("health_score", now - rangeMs, now);
      return c.json(data);
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
