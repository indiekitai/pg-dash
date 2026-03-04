// Notification formatters for Slack, Discord, and generic webhooks

import type { AlertRule, AlertHistoryEntry } from "./alerts.js";

export type WebhookType = "slack" | "discord" | "unknown";

const SEVERITY_COLORS: Record<string, { hex: string; decimal: number; emoji: string }> = {
  critical: { hex: "#e74c3c", decimal: 0xe74c3c, emoji: "🔴" },
  warning:  { hex: "#f39c12", decimal: 0xf39c12, emoji: "🟡" },
  info:     { hex: "#3498db", decimal: 0x3498db, emoji: "🔵" },
};

export function detectWebhookType(url: string): WebhookType {
  try {
    const { hostname } = new URL(url);
    if (hostname.endsWith("hooks.slack.com")) return "slack";
    if (hostname.endsWith("discord.com") || hostname.endsWith("discordapp.com")) return "discord";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function formatSlackMessage(alert: AlertHistoryEntry, rule: AlertRule): object {
  const colors = SEVERITY_COLORS[rule.severity] || SEVERITY_COLORS.info;
  return {
    attachments: [
      {
        color: colors.hex,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${colors.emoji} *pg-dash Alert: ${rule.name}*`,
            },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Metric:*\n${rule.metric}` },
              { type: "mrkdwn", text: `*Current Value:*\n${alert.value}` },
              { type: "mrkdwn", text: `*Threshold:*\n${rule.operator} ${rule.threshold}` },
              { type: "mrkdwn", text: `*Severity:*\n${rule.severity}` },
              { type: "mrkdwn", text: `*Timestamp:*\n${new Date(alert.timestamp).toISOString()}` },
            ],
          },
        ],
      },
    ],
  };
}

export function formatDiscordMessage(alert: AlertHistoryEntry, rule: AlertRule): object {
  const colors = SEVERITY_COLORS[rule.severity] || SEVERITY_COLORS.info;
  return {
    embeds: [
      {
        title: `${colors.emoji} pg-dash Alert: ${rule.name}`,
        color: colors.decimal,
        fields: [
          { name: "Metric", value: rule.metric, inline: true },
          { name: "Current Value", value: String(alert.value), inline: true },
          { name: "Threshold", value: `${rule.operator} ${rule.threshold}`, inline: true },
          { name: "Severity", value: rule.severity, inline: true },
          { name: "Timestamp", value: new Date(alert.timestamp).toISOString(), inline: false },
        ],
        footer: { text: "pg-dash · PostgreSQL Monitoring" },
      },
    ],
  };
}

export function formatGenericWebhook(alert: AlertHistoryEntry, rule: AlertRule): object {
  return {
    severity: rule.severity,
    rule: rule.name,
    metric: rule.metric,
    value: alert.value,
    message: alert.message,
    timestamp: alert.timestamp,
  };
}

export function formatWebhookPayload(alert: AlertHistoryEntry, rule: AlertRule, webhookUrl: string): object {
  const type = detectWebhookType(webhookUrl);
  switch (type) {
    case "slack": return formatSlackMessage(alert, rule);
    case "discord": return formatDiscordMessage(alert, rule);
    default: return formatGenericWebhook(alert, rule);
  }
}

export function getSeverityColor(severity: string) {
  return SEVERITY_COLORS[severity] || SEVERITY_COLORS.info;
}
