import type { Hono } from "hono";
import type { QueryStatsStore } from "../query-stats.js";

const RANGE_MAP: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export function registerQueryStatsRoutes(app: Hono, store: QueryStatsStore) {
  app.get("/api/query-stats/top", (c) => {
    try {
      const range = c.req.query("range") || "1h";
      const orderBy = (c.req.query("orderBy") || "total_time") as "total_time" | "mean_time" | "calls";
      const limit = parseInt(c.req.query("limit") || "20", 10);
      const rangeMs = RANGE_MAP[range] || RANGE_MAP["1h"];
      const now = Date.now();
      const data = store.getTopQueries(now - rangeMs, now, orderBy, limit);
      return c.json(data);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/query-stats/trend/:queryid", (c) => {
    try {
      const queryid = c.req.param("queryid");
      const range = c.req.query("range") || "1h";
      const rangeMs = RANGE_MAP[range] || RANGE_MAP["1h"];
      const now = Date.now();
      const data = store.getTrend(queryid, now - rangeMs, now);
      return c.json(data);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}
