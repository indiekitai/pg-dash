// Alerts system — rules stored in SQLite, threshold checking with cooldown, webhook notifications

import type Database from "better-sqlite3";
import { formatWebhookPayload, detectWebhookType } from "./notifiers.js";

export interface AlertRule {
  id: number;
  name: string;
  metric: string;
  operator: "gt" | "lt" | "eq";
  threshold: number;
  severity: "info" | "warning" | "critical";
  enabled: number;
  cooldown_minutes: number;
}

export interface AlertHistoryEntry {
  id: number;
  rule_id: number;
  timestamp: number;
  value: number;
  message: string;
  notified: number;
}

const DEFAULT_RULES: Omit<AlertRule, "id">[] = [
  { name: "Connection utilization > 80%", metric: "connection_util", operator: "gt", threshold: 80, severity: "warning", enabled: 1, cooldown_minutes: 60 },
  { name: "Connection utilization > 90%", metric: "connection_util", operator: "gt", threshold: 90, severity: "critical", enabled: 1, cooldown_minutes: 30 },
  { name: "Cache hit ratio < 99%", metric: "cache_hit_pct", operator: "lt", threshold: 99, severity: "warning", enabled: 1, cooldown_minutes: 60 },
  { name: "Cache hit ratio < 95%", metric: "cache_hit_pct", operator: "lt", threshold: 95, severity: "critical", enabled: 1, cooldown_minutes: 30 },
  { name: "Long-running query > 5 min", metric: "long_query_count", operator: "gt", threshold: 0, severity: "warning", enabled: 1, cooldown_minutes: 15 },
  { name: "Idle in transaction > 10 min", metric: "idle_in_tx_count", operator: "gt", threshold: 0, severity: "warning", enabled: 1, cooldown_minutes: 15 },
  { name: "Health score below D", metric: "health_score", operator: "lt", threshold: 50, severity: "warning", enabled: 1, cooldown_minutes: 120 },
  { name: "Database size growth > 10% in 24h", metric: "db_growth_pct_24h", operator: "gt", threshold: 10, severity: "warning", enabled: 1, cooldown_minutes: 60 },
  { name: "Predicted disk full within 7 days", metric: "days_until_full", operator: "lt", threshold: 7, severity: "critical", enabled: 1, cooldown_minutes: 360 },
];

export class AlertManager {
  private db: Database.Database;
  private webhookUrl: string | null;

  constructor(db: Database.Database, webhookUrl?: string) {
    this.db = db;
    this.webhookUrl = webhookUrl || null;
    this.initTables();
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        threshold REAL NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning',
        enabled INTEGER DEFAULT 1,
        cooldown_minutes INTEGER DEFAULT 60
      );
      CREATE TABLE IF NOT EXISTS alert_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        message TEXT NOT NULL,
        notified INTEGER DEFAULT 0,
        FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
      );
    `);

    // Seed default rules on first run
    const count = (this.db.prepare("SELECT COUNT(*) as c FROM alert_rules").get() as any).c;
    if (count === 0) {
      const insert = this.db.prepare("INSERT INTO alert_rules (name, metric, operator, threshold, severity, enabled, cooldown_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const tx = this.db.transaction(() => {
        for (const r of DEFAULT_RULES) {
          insert.run(r.name, r.metric, r.operator, r.threshold, r.severity, r.enabled, r.cooldown_minutes);
        }
      });
      tx();
    }
  }

  getRules(): AlertRule[] {
    return this.db.prepare("SELECT * FROM alert_rules ORDER BY id").all() as AlertRule[];
  }

  addRule(rule: Omit<AlertRule, "id">): AlertRule {
    const info = this.db.prepare("INSERT INTO alert_rules (name, metric, operator, threshold, severity, enabled, cooldown_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      rule.name, rule.metric, rule.operator, rule.threshold, rule.severity, rule.enabled ?? 1, rule.cooldown_minutes ?? 60
    );
    return { ...rule, id: Number(info.lastInsertRowid) } as AlertRule;
  }

  updateRule(id: number, updates: Partial<Omit<AlertRule, "id">>): boolean {
    const existing = this.db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(id) as AlertRule | undefined;
    if (!existing) return false;
    const merged = { ...existing, ...updates };
    this.db.prepare("UPDATE alert_rules SET name=?, metric=?, operator=?, threshold=?, severity=?, enabled=?, cooldown_minutes=? WHERE id=?").run(
      merged.name, merged.metric, merged.operator, merged.threshold, merged.severity, merged.enabled, merged.cooldown_minutes, id
    );
    return true;
  }

  deleteRule(id: number): boolean {
    const info = this.db.prepare("DELETE FROM alert_rules WHERE id = ?").run(id);
    return info.changes > 0;
  }

  getHistory(limit = 50): AlertHistoryEntry[] {
    return this.db.prepare("SELECT * FROM alert_history ORDER BY timestamp DESC LIMIT ?").all(limit) as AlertHistoryEntry[];
  }

  /**
   * Check all enabled rules against current metric values.
   * `metrics` is a map of metric name → current value.
   */
  checkAlerts(metrics: Record<string, number>): AlertHistoryEntry[] {
    const rules = this.db.prepare("SELECT * FROM alert_rules WHERE enabled = 1").all() as AlertRule[];
    const fired: AlertHistoryEntry[] = [];
    const now = Date.now();

    for (const rule of rules) {
      const value = metrics[rule.metric];
      if (value === undefined) continue;

      const triggered = this.evaluateRule(rule, value);
      if (!triggered) continue;

      // Check cooldown
      const lastAlert = this.db.prepare(
        "SELECT timestamp FROM alert_history WHERE rule_id = ? ORDER BY timestamp DESC LIMIT 1"
      ).get(rule.id) as { timestamp: number } | undefined;

      if (lastAlert && (now - lastAlert.timestamp) < rule.cooldown_minutes * 60 * 1000) {
        continue; // Still in cooldown
      }

      const message = `${rule.name}: ${rule.metric} = ${value} (threshold: ${rule.operator} ${rule.threshold})`;
      const info = this.db.prepare("INSERT INTO alert_history (rule_id, timestamp, value, message, notified) VALUES (?, ?, ?, ?, 0)").run(
        rule.id, now, value, message
      );
      const entry: AlertHistoryEntry = { id: Number(info.lastInsertRowid), rule_id: rule.id, timestamp: now, value, message, notified: 0 };
      fired.push(entry);

      // Log to console
      const icon = rule.severity === "critical" ? "🔴" : rule.severity === "warning" ? "🟡" : "🔵";
      console.log(`[alert] ${icon} ${message}`);

      // Webhook notification
      if (this.webhookUrl) {
        this.sendWebhook(rule, entry).catch((err) => console.error("[alert] Webhook failed:", err.message));
      }
    }

    return fired;
  }

  evaluateRule(rule: Pick<AlertRule, "operator" | "threshold">, value: number): boolean {
    switch (rule.operator) {
      case "gt": return value > rule.threshold;
      case "lt": return value < rule.threshold;
      case "eq": return value === rule.threshold;
      default: return false;
    }
  }

  getWebhookUrl(): string | null {
    return this.webhookUrl;
  }

  getWebhookType(): string | null {
    if (!this.webhookUrl) return null;
    return detectWebhookType(this.webhookUrl);
  }

  async sendTestWebhook(): Promise<{ ok: boolean; type: string; error?: string }> {
    if (!this.webhookUrl) return { ok: false, type: "none", error: "No webhook URL configured" };
    const type = detectWebhookType(this.webhookUrl);
    const testRule: AlertRule = {
      id: 0, name: "Test Alert", metric: "test_metric", operator: "gt",
      threshold: 80, severity: "info", enabled: 1, cooldown_minutes: 60,
    };
    const testEntry: AlertHistoryEntry = {
      id: 0, rule_id: 0, timestamp: Date.now(), value: 85,
      message: "Test Alert: test_metric = 85 (threshold: gt 80)", notified: 0,
    };
    try {
      const payload = formatWebhookPayload(testEntry, testRule, this.webhookUrl);
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return { ok: false, type, error: `HTTP ${res.status}` };
      return { ok: true, type };
    } catch (err) {
      return { ok: false, type, error: (err as Error).message };
    }
  }

  private async sendWebhook(rule: AlertRule, entry: AlertHistoryEntry) {
    if (!this.webhookUrl) return;
    try {
      const payload = formatWebhookPayload(entry, rule, this.webhookUrl);
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      this.db.prepare("UPDATE alert_history SET notified = 1 WHERE id = ?").run(entry.id);
    } catch (err) {
      console.error("[alert] Webhook error:", (err as Error).message);
    }
  }
}
