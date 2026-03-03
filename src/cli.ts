import { parseArgs } from "node:util";
import { startServer } from "./server/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", short: "p", default: "3480" },
    bind: { type: "string", default: "127.0.0.1" },
    auth: { type: "string" },
    token: { type: "string" },
    webhook: { type: "string" },
    "slack-webhook": { type: "string" },
    "discord-webhook": { type: "string" },
    "no-open": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    host: { type: "string" },
    user: { type: "string", short: "u" },
    password: { type: "string" },
    db: { type: "string", short: "d" },
    "pg-port": { type: "string" },
    "data-dir": { type: "string" },
    interval: { type: "string", short: "i" },
    "retention-days": { type: "string" },
    "snapshot-interval": { type: "string" },
    "query-stats-interval": { type: "string" },
    "long-query-threshold": { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    threshold: { type: "string" },
    format: { type: "string", short: "f" },
    ci: { type: "boolean", default: false },
    diff: { type: "boolean", default: false },
    "snapshot-path": { type: "string" },
  },
});

if (values.version) {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf-8"));
    console.log(`pg-dash v${pkg.version}`);
  } catch {
    console.log("pg-dash v0.1.0");
  }
  process.exit(0);
}

if (values.help) {
  console.log(`
pg-dash — Lightweight PostgreSQL Monitoring Dashboard

Usage:
  pg-dash <connection-string>
  pg-dash check <connection-string>     Run health check and exit
  pg-dash schema-diff <connection-string> Show latest schema changes
  pg-dash --host localhost --user postgres --db mydb

Options:
  -p, --port <port>      Dashboard port (default: 3480)
  --bind <addr>          Bind address (default: 127.0.0.1)
  --auth <user:pass>     Basic auth credentials (user:password)
  --token <token>        Bearer token for authentication
  --webhook <url>        Webhook URL for alert notifications
  --slack-webhook <url>  Slack webhook URL (convenience alias)
  --discord-webhook <url> Discord webhook URL (convenience alias)
  --no-open              Don't auto-open browser (default: opens)
  --json                 Dump health check as JSON and exit
  --host <host>          PostgreSQL host
  -u, --user <user>      PostgreSQL user
  --password <pass>      PostgreSQL password
  --db, -d <database>    PostgreSQL database
  --pg-port <port>       PostgreSQL port (default: 5432)
  --data-dir <dir>       Data directory for metrics (default: ~/.pg-dash)
  -i, --interval <sec>   Collection interval in seconds (default: 30)
  --retention-days <N>   Metrics retention in days (default: 7)
  --snapshot-interval <h> Schema snapshot interval in hours (default: 6)
  --query-stats-interval <min> Query stats snapshot interval in minutes (default: 5)
  --long-query-threshold <min> Long query threshold in minutes (default: 5)
  --threshold <score>    Health score threshold for check command (default: 70)
  -f, --format <fmt>     Output format: text|json|md (default: text)
  --ci                   Output GitHub Actions compatible annotations
  --diff                 Compare with previous run (saves snapshot for next run)
  --snapshot-path <path> Path to snapshot file for --diff (default: ~/.pg-dash/last-check.json)
  -v, --version          Show version
  -h, --help             Show this help

Environment variables:
  PG_DASH_RETENTION_DAYS, PG_DASH_SNAPSHOT_INTERVAL, PG_DASH_LONG_QUERY_THRESHOLD
`);
  process.exit(0);
}

const subcommand = positionals[0];

function resolveConnectionString(startIdx = 0): string {
  let connStr = positionals[startIdx];
  if (!connStr) {
    if (values.host) {
      const user = values.user || "postgres";
      const pass = values.password ? `:${values.password}` : "";
      const host = values.host;
      const pgPort = values["pg-port"] || "5432";
      const db = values.db || "postgres";
      connStr = `postgresql://${user}${pass}@${host}:${pgPort}/${db}`;
    } else {
      console.error("Error: provide a connection string or --host\n\nRun pg-dash --help for usage.");
      process.exit(1);
    }
  }
  return connStr;
}

if (subcommand === "check") {
  // Health check mode
  const connectionString = resolveConnectionString(1);
  const threshold = parseInt(values.threshold || "70", 10);
  const format = values.format || "text";
  const ci = values.ci || false;
  const useDiff = values.diff || false;

  const { Pool } = await import("pg");
  const { getAdvisorReport } = await import("./server/advisor.js");
  const { saveSnapshot, loadSnapshot, diffSnapshots } = await import("./server/snapshot.js");
  const os = await import("node:os");

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10000 });
  const checkDataDir = values["data-dir"] || path.join(os.homedir(), ".pg-dash");
  // --snapshot-path lets CI persist the snapshot across ephemeral runners via cache
  const snapshotPath = values["snapshot-path"] || path.join(checkDataDir, "last-check.json");

  try {
    const lqt = parseInt(values["long-query-threshold"] || process.env.PG_DASH_LONG_QUERY_THRESHOLD || "5", 10);
    const report = await getAdvisorReport(pool, lqt);

    // Diff logic
    let diff: import("./server/snapshot.js").SnapshotDiff | null = null;
    if (useDiff) {
      const prev = loadSnapshot(snapshotPath);
      if (prev) {
        diff = diffSnapshots(prev.result, report);
      }
      saveSnapshot(snapshotPath, report);
    }

    if (format === "json") {
      const output: any = { ...report };
      if (diff) output.diff = diff;
      console.log(JSON.stringify(output, null, 2));
    } else if (format === "md" || (ci && format !== "text")) {
      // Markdown report (for CI PR comments)
      console.log(`## 🏥 pg-dash Health Report\n`);
      if (diff) {
        const sign = diff.scoreDelta >= 0 ? "+" : "";
        console.log(`**Score: ${diff.previousScore} → ${report.score} (${sign}${diff.scoreDelta})**\n`);
      } else {
        console.log(`**Score: ${report.score}/100 (${report.grade})**\n`);
      }
      console.log(`| Category | Score | Grade | Issues |`);
      console.log(`|----------|-------|-------|--------|`);
      for (const [cat, b] of Object.entries(report.breakdown)) {
        console.log(`| ${cat} | ${b.score} | ${b.grade} | ${b.count} |`);
      }
      if (diff) {
        if (diff.resolvedIssues.length > 0) {
          console.log(`\n### ✅ Resolved (${diff.resolvedIssues.length})`);
          for (const i of diff.resolvedIssues) console.log(`- ~~${i.title}~~`);
        }
        if (diff.newIssues.length > 0) {
          console.log(`\n### 🆕 New Issues (${diff.newIssues.length})`);
          for (const i of diff.newIssues) {
            const icon = i.severity === "critical" ? "🔴" : i.severity === "warning" ? "🟡" : "🔵";
            console.log(`- ${icon} [${i.severity}] ${i.title}`);
          }
        }
      }
      if (report.issues.length > 0) {
        console.log(`\n### ⚠️ Issues (${report.issues.length})\n`);
        for (const issue of report.issues) {
          const sev = issue.severity === "critical" ? "error" : issue.severity === "warning" ? "warning" : "notice";
          console.log(`- [${sev}] ${issue.title}`);
        }
      } else {
        console.log(`\n✅ No issues found!`);
      }
      if (report.batchFixes.length > 0) {
        console.log(`\n### 🔧 Batch Fixes\n`);
        console.log("```sql");
        for (const fix of report.batchFixes) {
          console.log(`-- ${fix.title}`);
          console.log(fix.sql);
        }
        console.log("```");
      }
    } else if (ci) {
      // GitHub Actions annotations
      for (const issue of report.issues) {
        const level = issue.severity === "critical" ? "error" : issue.severity === "warning" ? "warning" : "notice";
        console.log(`::${level}::${issue.title}: ${issue.description}`);
      }
      // Summary table
      console.log(`\nHealth Score: ${report.score}/100 (${report.grade})`);
      for (const [cat, b] of Object.entries(report.breakdown)) {
        console.log(`  ${cat.padEnd(14)} ${b.grade} (${b.score}/100) — ${b.count} issue${b.count !== 1 ? "s" : ""}`);
      }
      if (diff) {
        const sign = diff.scoreDelta >= 0 ? "+" : "";
        console.log(`\nScore: ${diff.previousScore} → ${report.score} (${sign}${diff.scoreDelta})`);
        console.log(`Resolved: ${diff.resolvedIssues.length} issues`);
        console.log(`New: ${diff.newIssues.length} issues`);
      }
    } else {
      // Plain text
      if (diff) {
        const sign = diff.scoreDelta >= 0 ? "+" : "";
        console.log(`\n  Score: ${diff.previousScore} → ${report.score} (${sign}${diff.scoreDelta})\n`);
        if (diff.resolvedIssues.length > 0) {
          console.log(`  ✅ Resolved: ${diff.resolvedIssues.length} issues`);
          for (const i of diff.resolvedIssues) console.log(`     - ${i.title}`);
        }
        if (diff.newIssues.length > 0) {
          console.log(`  🆕 New: ${diff.newIssues.length} issues`);
          for (const i of diff.newIssues) console.log(`     - ${i.title}`);
        }
        console.log();
      } else {
        console.log(`\n  Health Score: ${report.score}/100 (Grade: ${report.grade})\n`);
      }
      for (const [cat, b] of Object.entries(report.breakdown)) {
        console.log(`  ${cat.padEnd(14)} ${b.grade} (${b.score}/100) — ${b.count} issue${b.count !== 1 ? "s" : ""}`);
      }
      if (report.issues.length > 0) {
        console.log(`\n  Issues (${report.issues.length}):\n`);
        for (const issue of report.issues) {
          const icon = issue.severity === "critical" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
          console.log(`  ${icon} [${issue.severity}] ${issue.title}`);
        }
      }
      console.log();
    }
    await pool.end();
    process.exit(report.score < threshold ? 1 : 0);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    await pool.end();
    process.exit(1);
  }
} else if (subcommand === "schema-diff") {
  // Schema diff mode
  const connectionString = resolveConnectionString(1);
  const dataDir = values["data-dir"] || path.join((await import("node:os")).homedir(), ".pg-dash");
  const schemaDbPath = path.join(dataDir, "schema.db");

  if (!fs.existsSync(schemaDbPath)) {
    console.error("No schema tracking data found. Run pg-dash server first to collect schema snapshots.");
    process.exit(1);
  }

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(schemaDbPath, { readonly: true });
  const changes = db.prepare("SELECT * FROM schema_changes ORDER BY timestamp DESC LIMIT 50").all() as any[];
  db.close();

  if (changes.length === 0) {
    console.log("No schema changes detected.");
  } else {
    console.log(`\n  Schema Changes (${changes.length}):\n`);
    for (const c of changes) {
      const icon = c.change_type === "added" ? "＋" : c.change_type === "removed" ? "−" : "~";
      const color = c.change_type === "added" ? "\x1b[32m" : c.change_type === "removed" ? "\x1b[31m" : "\x1b[33m";
      console.log(`  ${color}${icon}\x1b[0m ${c.detail}${c.table_name ? ` (${c.table_name})` : ""} — ${new Date(c.timestamp).toLocaleString()}`);
    }
    console.log();
  }
  process.exit(0);
} else {
  // Default: start server
  const connectionString = resolveConnectionString(0);
  const port = parseInt(values.port!, 10);
  const bind = values.bind || process.env.PG_DASH_BIND || "127.0.0.1";
  const interval = values.interval ? parseInt(values.interval, 10) : undefined;
  const retentionDays = parseInt(values["retention-days"] || process.env.PG_DASH_RETENTION_DAYS || "7", 10);
  const snapshotInterval = parseInt(values["snapshot-interval"] || process.env.PG_DASH_SNAPSHOT_INTERVAL || "6", 10);
  const queryStatsInterval = parseInt(values["query-stats-interval"] || process.env.PG_DASH_QUERY_STATS_INTERVAL || "5", 10);
  const longQueryThreshold = parseInt(values["long-query-threshold"] || process.env.PG_DASH_LONG_QUERY_THRESHOLD || "5", 10);
  const auth = values.auth || undefined;
  const token = values.token || undefined;
  const webhook = values["slack-webhook"] || values["discord-webhook"] || values.webhook || undefined;

  // Security warning
  if (bind === "0.0.0.0" && !auth && !token) {
    console.warn("\n  ⚠️  WARNING: Dashboard is exposed without authentication. Use --auth or --token.\n");
  }

  await startServer({
    connectionString,
    port,
    bind,
    open: !values["no-open"],
    json: values.json!,
    dataDir: values["data-dir"],
    interval,
    retentionDays,
    snapshotInterval,
    queryStatsInterval,
    longQueryThreshold,
    auth,
    token,
    webhook,
  });
}
