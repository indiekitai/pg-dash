import { describe, it, expect } from "vitest";
import {
  detectWebhookType,
  formatSlackMessage,
  formatDiscordMessage,
  formatGenericWebhook,
  formatWebhookPayload,
  getSeverityColor,
} from "../notifiers.js";
import type { AlertRule, AlertHistoryEntry } from "../alerts.js";

const mockRule: AlertRule = {
  id: 1, name: "High CPU", metric: "connection_util", operator: "gt",
  threshold: 80, severity: "critical", enabled: 1, cooldown_minutes: 60,
};

const mockAlert: AlertHistoryEntry = {
  id: 1, rule_id: 1, timestamp: 1700000000000, value: 95,
  message: "High CPU: connection_util = 95 (threshold: gt 80)", notified: 0,
};

describe("detectWebhookType", () => {
  it("detects Slack", () => {
    expect(detectWebhookType("https://hooks.slack.com/services/T00/B00/xxx")).toBe("slack");
  });
  it("detects Discord", () => {
    expect(detectWebhookType("https://discord.com/api/webhooks/123/abc")).toBe("discord");
    expect(detectWebhookType("https://discordapp.com/api/webhooks/123/abc")).toBe("discord");
  });
  it("returns generic for unknown URLs", () => {
    expect(detectWebhookType("https://example.com/webhook")).toBe("generic");
    expect(detectWebhookType("https://my-server.com/hooks")).toBe("generic");
  });
  it("handles edge cases", () => {
    expect(detectWebhookType("")).toBe("generic");
    expect(detectWebhookType("https://not-slack.hooks.slack.com.evil.com")).toBe("slack");
  });
});

describe("formatSlackMessage", () => {
  it("returns valid Slack Block Kit payload", () => {
    const msg = formatSlackMessage(mockAlert, mockRule) as any;
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].color).toBe("#e74c3c");
    expect(msg.attachments[0].blocks).toHaveLength(2);
    expect(msg.attachments[0].blocks[0].type).toBe("section");
    expect(msg.attachments[0].blocks[1].fields.length).toBeGreaterThanOrEqual(4);
  });

  it("includes emoji in title", () => {
    const msg = formatSlackMessage(mockAlert, mockRule) as any;
    expect(msg.attachments[0].blocks[0].text.text).toContain("🔴");
  });
});

describe("formatDiscordMessage", () => {
  it("returns valid Discord embed payload", () => {
    const msg = formatDiscordMessage(mockAlert, mockRule) as any;
    expect(msg.embeds).toBeDefined();
    expect(msg.embeds).toHaveLength(1);
    expect(msg.embeds[0].color).toBe(0xe74c3c);
    expect(msg.embeds[0].fields.length).toBeGreaterThanOrEqual(4);
    expect(msg.embeds[0].footer.text).toContain("pg-dash");
  });

  it("includes emoji in title", () => {
    const msg = formatDiscordMessage(mockAlert, mockRule) as any;
    expect(msg.embeds[0].title).toContain("🔴");
  });
});

describe("formatGenericWebhook", () => {
  it("returns backwards-compatible JSON", () => {
    const msg = formatGenericWebhook(mockAlert, mockRule) as any;
    expect(msg).toEqual({
      severity: "critical",
      rule: "High CPU",
      metric: "connection_util",
      value: 95,
      message: mockAlert.message,
      timestamp: mockAlert.timestamp,
    });
  });
});

describe("formatWebhookPayload", () => {
  it("auto-selects Slack format", () => {
    const msg = formatWebhookPayload(mockAlert, mockRule, "https://hooks.slack.com/services/x") as any;
    expect(msg.attachments).toBeDefined();
  });
  it("auto-selects Discord format", () => {
    const msg = formatWebhookPayload(mockAlert, mockRule, "https://discord.com/api/webhooks/x") as any;
    expect(msg.embeds).toBeDefined();
  });
  it("auto-selects generic format", () => {
    const msg = formatWebhookPayload(mockAlert, mockRule, "https://example.com/hook") as any;
    expect(msg.severity).toBe("critical");
  });
});

describe("getSeverityColor", () => {
  it("maps critical to red", () => {
    expect(getSeverityColor("critical").hex).toBe("#e74c3c");
  });
  it("maps warning to yellow", () => {
    expect(getSeverityColor("warning").hex).toBe("#f39c12");
  });
  it("maps info to blue", () => {
    expect(getSeverityColor("info").hex).toBe("#3498db");
  });
  it("defaults to info for unknown", () => {
    expect(getSeverityColor("unknown").hex).toBe("#3498db");
  });
});
