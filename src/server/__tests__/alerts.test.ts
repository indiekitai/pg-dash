import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { AlertManager } from "../alerts.js";

describe("AlertManager", () => {
  let db: Database.Database;
  let manager: AlertManager;

  beforeEach(() => {
    db = new Database(":memory:");
    manager = new AlertManager(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates default rules on first init", () => {
    const rules = manager.getRules();
    expect(rules.length).toBeGreaterThanOrEqual(5);
    expect(rules.some((r) => r.metric === "connection_util")).toBe(true);
    expect(rules.some((r) => r.metric === "cache_hit_pct")).toBe(true);
    expect(rules.some((r) => r.metric === "health_score")).toBe(true);
  });

  it("does not duplicate default rules on second init", () => {
    const count1 = manager.getRules().length;
    const manager2 = new AlertManager(db);
    const count2 = manager2.getRules().length;
    expect(count2).toBe(count1);
  });

  it("adds and deletes rules", () => {
    const before = manager.getRules().length;
    const rule = manager.addRule({
      name: "Test rule",
      metric: "connection_util",
      operator: "gt",
      threshold: 50,
      severity: "info",
      enabled: 1,
      cooldown_minutes: 10,
    });
    expect(manager.getRules().length).toBe(before + 1);
    expect(rule.id).toBeGreaterThan(0);
    manager.deleteRule(rule.id);
    expect(manager.getRules().length).toBe(before);
  });

  it("updates rules", () => {
    const rules = manager.getRules();
    const first = rules[0];
    manager.updateRule(first.id, { threshold: 999 });
    const updated = manager.getRules().find((r) => r.id === first.id)!;
    expect(updated.threshold).toBe(999);
  });

  it("updateRule returns false for non-existent rule", () => {
    expect(manager.updateRule(99999, { threshold: 1 })).toBe(false);
  });

  it("deleteRule returns false for non-existent rule", () => {
    expect(manager.deleteRule(99999)).toBe(false);
  });

  describe("evaluateRule", () => {
    it("gt operator", () => {
      expect(manager.evaluateRule({ operator: "gt", threshold: 80 }, 90)).toBe(true);
      expect(manager.evaluateRule({ operator: "gt", threshold: 80 }, 80)).toBe(false);
      expect(manager.evaluateRule({ operator: "gt", threshold: 80 }, 70)).toBe(false);
    });

    it("lt operator", () => {
      expect(manager.evaluateRule({ operator: "lt", threshold: 99 }, 98)).toBe(true);
      expect(manager.evaluateRule({ operator: "lt", threshold: 99 }, 99)).toBe(false);
      expect(manager.evaluateRule({ operator: "lt", threshold: 99 }, 100)).toBe(false);
    });

    it("eq operator", () => {
      expect(manager.evaluateRule({ operator: "eq", threshold: 0 }, 0)).toBe(true);
      expect(manager.evaluateRule({ operator: "eq", threshold: 0 }, 1)).toBe(false);
    });

    it("unknown operator returns false", () => {
      expect(manager.evaluateRule({ operator: "gte" as any, threshold: 0 }, 0)).toBe(false);
    });
  });

  describe("checkAlerts", () => {
    it("fires alerts when threshold exceeded", () => {
      const fired = manager.checkAlerts({ connection_util: 95 });
      expect(fired.length).toBeGreaterThanOrEqual(2);
      expect(fired.every((a) => a.message.includes("connection_util"))).toBe(true);
    });

    it("does not fire when below threshold", () => {
      const fired = manager.checkAlerts({ connection_util: 50 });
      const connFired = fired.filter((a) => a.message.includes("connection_util"));
      expect(connFired.length).toBe(0);
    });

    it("respects cooldown", () => {
      const first = manager.checkAlerts({ connection_util: 95 });
      expect(first.length).toBeGreaterThan(0);
      const second = manager.checkAlerts({ connection_util: 95 });
      const connFired = second.filter((a) => a.message.includes("connection_util"));
      expect(connFired.length).toBe(0);
    });

    it("fires again after cooldown expires", () => {
      // Add a rule with 0 cooldown
      const rule = manager.addRule({
        name: "Zero cooldown",
        metric: "test_metric",
        operator: "gt",
        threshold: 0,
        severity: "info",
        enabled: 1,
        cooldown_minutes: 0,
      });
      const first = manager.checkAlerts({ test_metric: 5 });
      expect(first.some((a) => a.rule_id === rule.id)).toBe(true);
      // With 0 cooldown, should fire again immediately
      const second = manager.checkAlerts({ test_metric: 5 });
      expect(second.some((a) => a.rule_id === rule.id)).toBe(true);
    });

    it("ignores missing metrics", () => {
      const fired = manager.checkAlerts({ nonexistent_metric: 999 });
      expect(fired.length).toBe(0);
    });

    it("skips disabled rules", () => {
      const rules = manager.getRules().filter((r) => r.metric === "connection_util");
      for (const r of rules) manager.updateRule(r.id, { enabled: 0 });
      const fired = manager.checkAlerts({ connection_util: 95 });
      const connFired = fired.filter((a) => a.message.includes("connection_util"));
      expect(connFired.length).toBe(0);
    });

    it("records history", () => {
      manager.checkAlerts({ connection_util: 95 });
      const history = manager.getHistory();
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].message).toContain("connection_util");
    });
  });

  describe("webhook notification", () => {
    it("calls webhook when configured and alert fires", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      const dbW = new Database(":memory:");
      const mgr = new AlertManager(dbW, "https://example.com/webhook");
      mgr.addRule({
        name: "Webhook test",
        metric: "test_m",
        operator: "gt",
        threshold: 0,
        severity: "warning",
        enabled: 1,
        cooldown_minutes: 0,
      });

      mgr.checkAlerts({ test_m: 5 });

      // Wait for async webhook
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch).toHaveBeenCalledWith("https://example.com/webhook", expect.objectContaining({ method: "POST" }));

      dbW.close();
      vi.unstubAllGlobals();
    });

    it("does not call webhook when not configured", () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      manager.checkAlerts({ connection_util: 95 });

      expect(mockFetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });
});
