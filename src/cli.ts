import { parseArgs } from "node:util";
import { startServer } from "./server/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", short: "p", default: "3480" },
    open: { type: "boolean", default: true },
    json: { type: "boolean", default: false },
    host: { type: "string" },
    user: { type: "string", short: "u" },
    password: { type: "string" },
    db: { type: "string", short: "d" },
    "pg-port": { type: "string" },
    "data-dir": { type: "string" },
    interval: { type: "string", short: "i" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
pg-dash — Lightweight PostgreSQL Monitoring Dashboard

Usage:
  pg-dash <connection-string>
  pg-dash --host localhost --user postgres --db mydb

Options:
  -p, --port <port>      Dashboard port (default: 3480)
  --open                 Auto-open browser (default: true)
  --no-open              Don't auto-open browser
  --json                 Dump health check as JSON and exit
  --host <host>          PostgreSQL host
  -u, --user <user>      PostgreSQL user
  --password <pass>      PostgreSQL password
  --db, -d <database>    PostgreSQL database
  --pg-port <port>       PostgreSQL port (default: 5432)
  --data-dir <dir>       Data directory for metrics (default: ~/.pg-dash)
  -i, --interval <sec>   Collection interval in seconds (default: 30)
  -h, --help             Show this help
`);
  process.exit(0);
}

let connectionString = positionals[0];

if (!connectionString) {
  if (values.host) {
    const user = values.user || "postgres";
    const pass = values.password ? `:${values.password}` : "";
    const host = values.host;
    const pgPort = values["pg-port"] || "5432";
    const db = values.db || "postgres";
    connectionString = `postgresql://${user}${pass}@${host}:${pgPort}/${db}`;
  } else {
    console.error(
      "Error: provide a connection string or --host\n\nRun pg-dash --help for usage."
    );
    process.exit(1);
  }
}

const port = parseInt(values.port!, 10);
const interval = values.interval ? parseInt(values.interval, 10) : undefined;

startServer({
  connectionString,
  port,
  open: values.open!,
  json: values.json!,
  dataDir: values["data-dir"],
  interval,
});
