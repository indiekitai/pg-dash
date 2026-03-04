import type { Hono } from "hono";
import type { AlertManager } from "../alerts.js";

export function registerAlertsRoutes(app: Hono, alertManager: AlertManager) {
  app.get("/api/alerts/rules", async (c) => {
    try { return c.json(alertManager.getRules()); }
    catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/alerts/rules", async (c) => {
    try {
      const body = await c.req.json();
      const rule = alertManager.addRule(body);
      return c.json(rule, 201);
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.put("/api/alerts/rules/:id", async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const body = await c.req.json();
      const ok = alertManager.updateRule(id, body);
      if (!ok) return c.json({ error: "Rule not found" }, 404);
      return c.json({ ok: true });
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.delete("/api/alerts/rules/:id", async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const ok = alertManager.deleteRule(id);
      if (!ok) return c.json({ error: "Rule not found" }, 404);
      return c.json({ ok: true });
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/alerts/webhook-info", async (c) => {
    try {
      const url = alertManager.getWebhookUrl();
      const type = alertManager.getWebhookType();
      const masked = url ? url.replace(/\/[^/]{8,}$/, "/****") : null;
      return c.json({ url: masked, type: type || "none", configured: !!url });
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/alerts/test-webhook", async (c) => {
    try {
      const result = await alertManager.sendTestWebhook();
      return c.json(result, result.ok ? 200 : 400);
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/alerts/history", async (c) => {
    try {
      const limit = parseInt(c.req.query("limit") || "50");
      return c.json(alertManager.getHistory(limit));
    } catch (err: any) { return c.json({ error: err.message }, 500); }
  });
}
