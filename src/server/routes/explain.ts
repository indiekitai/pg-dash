import type { Hono } from "hono";
import type { Pool } from "pg";
import { analyzeExplainPlan } from "../query-analyzer.js";

const DDL_PATTERN = /\b(CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i;

export function registerExplainRoutes(app: Hono, pool: Pool) {
  app.post("/api/explain", async (c) => {
    try {
      const body = await c.req.json();
      const query = body?.query?.trim();
      if (!query) return c.json({ error: "Missing query" }, 400);
      if (DDL_PATTERN.test(query)) return c.json({ error: "DDL statements are not allowed" }, 400);
      if (!/^\s*SELECT\b/i.test(query)) return c.json({ error: "Only SELECT queries can be explained for safety. DELETE/UPDATE/INSERT are blocked." }, 400);

      const client = await pool.connect();
      try {
        await client.query("SET statement_timeout = '30s'");
        await client.query("BEGIN");
        try {
          const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
          await client.query("ROLLBACK");
          await client.query("RESET statement_timeout");

          const plan = r.rows[0]["QUERY PLAN"];

          // Deep analysis (best-effort; never throws)
          let analysis = null;
          try {
            analysis = await analyzeExplainPlan(plan, pool);
          } catch {
            // analysis unavailable — return plan only
          }

          return c.json({ plan, analysis });
        } catch (err: any) {
          await client.query("ROLLBACK").catch(() => {});
          await client.query("RESET statement_timeout").catch(() => {});
          return c.json({ error: err.message }, 400);
        }
      } finally {
        client.release();
      }
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}
