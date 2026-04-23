import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server/index.js";

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
  },
});

if (values.version) {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf-8"));
    console.log(`pg-dash v${pkg.version}`);
  } catch {
    console.log("pg-dash (version unknown)");
  }
  process.exit(0);
}

if (values.help) {
  console.log(`
pg-dash — Self-hostable PostgreSQL monitoring dashboard

Usage:
  pg-dash <connection-string>                   Start the dashboard
  pg-dash --host <h> --user <u> --db <name>     Start from flag-based args

Options:
  -p, --port <port>            Dashboard port (default: 3480)
  --bind <addr>                Bind address (default: 127.0.0.1)
  --auth <user:pass>           Basic auth credentials
  --token <token>              Bearer token for authentication
  --webhook <url>              Webhook URL for alert notifications
  --slack-webhook <url>        Slack webhook URL (convenience alias)
  --discord-webhook <url>      Discord webhook URL (convenience alias)
  --no-open                    Don't auto-open browser
  --host <host>                PostgreSQL host (with --user/--db etc.)
  -u, --user <user>            PostgreSQL user
  --password <pass>            PostgreSQL password
  -d, --db <database>          PostgreSQL database
  --pg-port <port>             PostgreSQL port (default: 5432)
  --data-dir <dir>             Data directory (default: ~/.pg-dash)
  -i, --interval <sec>         Metric collection interval (default: 30)
  --retention-days <N>         Metrics retention in days (default: 7)
  --snapshot-interval <h>      Schema snapshot interval in hours (default: 6)
  --query-stats-interval <min> Query stats snapshot interval (default: 5)
  --long-query-threshold <min> Long-query threshold (default: 5)
  -v, --version                Show version
  -h, --help                   Show this help

Environment variables:
  DATABASE_URL         PostgreSQL connection string (fallback if no positional arg)
  PG_DASH_BIND         Override bind address
  PG_DASH_PORT         Override port
  PG_DASH_AUTH         Basic auth credentials (user:pass)
  PG_DASH_TOKEN        Bearer token
  PG_DASH_DATA_DIR     Data directory
  PG_DASH_WEBHOOK      Alert webhook URL

CLI & MCP users: check-migration, explain, and other CLI subcommands
have moved to pg-health (https://github.com/indiekitai/pg-health).
  pipx install pg-health
`);
  process.exit(0);
}

function isValidConnectionString(s: string): boolean {
  return (
    s.startsWith("postgresql://") ||
    s.startsWith("postgres://") ||
    s.includes("@") ||
    s.includes("=")
  );
}

function resolveConnectionString(): string {
  let connStr = positionals[0] || process.env.DATABASE_URL || "";
  if (!connStr) {
    if (values.host) {
      const user = values.user || "postgres";
      const pass = values.password ? `:${values.password}` : "";
      const host = values.host;
      const pgPort = values["pg-port"] || "5432";
      const db = values.db || "postgres";
      connStr = `postgresql://${user}${pass}@${host}:${pgPort}/${db}`;
    } else {
      console.error(
        "Error: provide a connection string or --host\n\n" +
        "  pg-dash postgresql://user:pass@host:5432/db\n\n" +
        "Run pg-dash --help for usage."
      );
      process.exit(1);
    }
  }
  if (!isValidConnectionString(connStr)) {
    console.error(
      `Error: "${connStr}" doesn't look like a valid connection string.\n` +
      `  Expected: postgresql://user:pass@host:5432/db\n\n` +
      `Note: as of v1.0, pg-dash is a dashboard only. CLI subcommands\n` +
      `(check, check-migration, explain, watch-locks, schema-diff, etc.)\n` +
      `moved to pg-health — https://github.com/indiekitai/pg-health\n\n` +
      `Run pg-dash --help for usage.`
    );
    process.exit(1);
  }
  return connStr;
}

const connectionString = resolveConnectionString();
const port = parseInt(values.port || process.env.PG_DASH_PORT || "3480", 10);
const bind = values.bind || process.env.PG_DASH_BIND || "127.0.0.1";
const interval = values.interval ? parseInt(values.interval, 10) : undefined;
const retentionDays = parseInt(
  values["retention-days"] || process.env.PG_DASH_RETENTION_DAYS || "7",
  10,
);
const snapshotInterval = parseInt(
  values["snapshot-interval"] || process.env.PG_DASH_SNAPSHOT_INTERVAL || "6",
  10,
);
const queryStatsInterval = parseInt(
  values["query-stats-interval"] || process.env.PG_DASH_QUERY_STATS_INTERVAL || "5",
  10,
);
const longQueryThreshold = parseInt(
  values["long-query-threshold"] || process.env.PG_DASH_LONG_QUERY_THRESHOLD || "5",
  10,
);
const auth = values.auth || process.env.PG_DASH_AUTH || undefined;
const token = values.token || process.env.PG_DASH_TOKEN || undefined;
const webhook =
  values["slack-webhook"] ||
  values["discord-webhook"] ||
  values.webhook ||
  process.env.PG_DASH_WEBHOOK ||
  undefined;

if (bind === "0.0.0.0" && !auth && !token) {
  console.warn("\n  ⚠️  WARNING: Dashboard is exposed without authentication. Use --auth or --token.\n");
}

await startServer({
  connectionString,
  port,
  bind,
  open: !values["no-open"],
  json: false,
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
