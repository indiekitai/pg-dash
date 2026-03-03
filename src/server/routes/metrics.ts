import type { Hono } from "hono";
import type { TimeseriesStore } from "../timeseries.js";
import type { Collector } from "../collector.js";

const RANGE_MAP: Record<string, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export function registerMetricsRoutes(app: Hono, store: TimeseriesStore, collector: Collector) {
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
}
