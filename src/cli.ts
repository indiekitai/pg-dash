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
    "no-open": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    host: { type: "string" },
    user: { type: "string", short: "u" },
    password: { type: "string" },
    db: { type: "string", short: "d" },
    "pg-port": { type: "string" },
    "data-dir": { type: "string" },
    interval: { type: "string", short: "i" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    threshold: { type: "string" },
    format: { type: "string", short: "f" },
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
  --no-open              Don't auto-open browser (default: opens)
  --json                 Dump health check as JSON and exit
  --host <host>          PostgreSQL host
  -u, --user <user>      PostgreSQL user
  --password <pass>      PostgreSQL password
  --db, -d <database>    PostgreSQL database
  --pg-port <port>       PostgreSQL port (default: 5432)
  --data-dir <dir>       Data directory for metrics (default: ~/.pg-dash)
  -i, --interval <sec>   Collection interval in seconds (default: 30)
  --threshold <score>    Health score threshold for check command (default: 70)
  -f, --format <fmt>     Output format: text|json (default: text)
  -v, --version          Show version
  -h, --help             Show this help
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

  const { Pool } = await import("pg");
  const { getAdvisorReport } = await import("./server/advisor.js");

  const pool = new Pool({ connectionString });
  try {
    const report = await getAdvisorReport(pool);
    if (format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n  Health Score: ${report.score}/100 (Grade: ${report.grade})\n`);
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
  const interval = values.interval ? parseInt(values.interval, 10) : undefined;

  await startServer({
    connectionString,
    port,
    open: !values["no-open"],
    json: values.json!,
    dataDir: values["data-dir"],
    interval,
  });
}
