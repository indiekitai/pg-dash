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
    "no-analyze": { type: "boolean", default: false },
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
    source: { type: "string" },
    target: { type: "string" },
    health: { type: "boolean", default: false },
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
  pg-dash <connection-string>                           Start dashboard
  pg-dash check <connection-string>                     Run health check and exit
  pg-dash health <connection-string>                    Alias for check
  pg-dash check-migration <file> [connection]           Analyze migration SQL for risks
  pg-dash explain <query> <connection>                  EXPLAIN ANALYZE a query in the terminal
  pg-dash watch-locks <connection>                      Real-time lock + long-query monitor
  pg-dash diff-env --source <url> --target <url>        Compare two environments
  pg-dash schema-diff <connection-string>               Show latest schema changes
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
  --source <url>         Source database connection string (diff-env)
  --target <url>         Target database connection string (diff-env)
  --health               Also compare health scores and issues (diff-env)
  -v, --version          Show version
  -h, --help             Show this help

Environment variables:
  PG_DASH_RETENTION_DAYS, PG_DASH_SNAPSHOT_INTERVAL, PG_DASH_LONG_QUERY_THRESHOLD
`);
  process.exit(0);
}

const KNOWN_SUBCOMMANDS = ["check", "health", "check-migration", "schema-diff", "diff-env", "explain", "watch-locks"];
const subcommand = positionals[0];

function isValidConnectionString(s: string): boolean {
  return (
    s.startsWith("postgresql://") ||
    s.startsWith("postgres://") ||
    s.includes("@") ||      // user@host shorthand
    s.includes("=")         // key=value DSN
  );
}

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
  if (!isValidConnectionString(connStr)) {
    console.error(
      `Error: "${connStr}" doesn't look like a valid connection string.\n` +
      `  Expected: postgresql://user:pass@host:5432/db\n\n` +
      `Known subcommands: ${KNOWN_SUBCOMMANDS.join(", ")}\n` +
      `Run pg-dash --help for usage.`
    );
    process.exit(1);
  }
  return connStr;
}

if (subcommand === "check" || subcommand === "health") {
  // Health check mode (health is an alias for check)
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
} else if (subcommand === "check-migration") {
  // Migration safety check mode
  // Usage: pg-dash check-migration <file> [connection] [--ci] [-f json|text|md]
  const filePath = positionals[1];
  if (!filePath) {
    console.error("Error: provide a migration SQL file path.\n\nUsage: pg-dash check-migration <file> [connection]");
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(filePath, "utf-8");

  // Optional connection string (third positional arg)
  const migrationConn = positionals[2];
  const format = values.format || "text";
  const ci = values.ci || false;

  const { analyzeMigration } = await import("./server/migration-checker.js");

  let pool: import("pg").Pool | undefined;
  if (migrationConn) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: migrationConn, connectionTimeoutMillis: 10000 });
  }

  try {
    const result = await analyzeMigration(sql, pool);
    if (pool) await pool.end();

    const sep = "─".repeat(48);

    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else if (format === "md") {
      console.log("## 🔍 Migration Safety Check\n");
      console.log("| Severity | Code | Message |");
      console.log("|----------|------|---------|");
      for (const issue of result.issues) {
        const sev =
          issue.severity === "error"
            ? "🔴 ERROR"
            : issue.severity === "warning"
            ? "⚠️ WARNING"
            : "ℹ️ INFO";
        console.log(`| ${sev} | ${issue.code} | ${issue.message} |`);
      }
      const { errors, warnings, infos } = result.summary;
      const safeLabel = result.safe ? "✅ SAFE" : "❌ UNSAFE";
      console.log(`\n**Result: ${safeLabel} — ${errors} error${errors !== 1 ? "s" : ""}, ${warnings} warning${warnings !== 1 ? "s" : ""}, ${infos} info${infos !== 1 ? "s" : ""}**`);
    } else {
      // Text format
      console.log(`\nMigration check: ${filePath}`);
      console.log(sep);
      if (result.issues.length === 0) {
        console.log("\n  ✅ No issues found!\n");
      } else {
        for (const issue of result.issues) {
          const icon =
            issue.severity === "error" ? "✗" : issue.severity === "warning" ? "⚠" : "✓";
          const indent = "  ";
          const parts = [`${indent}${icon}  ${issue.message}`];
          if (issue.suggestion) parts.push(`${indent}   Suggestion: ${issue.suggestion}`);
          if (issue.estimatedRows !== undefined) {
            parts.push(
              `${indent}   Est. rows: ${issue.estimatedRows.toLocaleString()}` +
                (issue.estimatedLockSeconds !== undefined
                  ? `, lock ~${issue.estimatedLockSeconds}s`
                  : "")
            );
          }
          if (issue.lineNumber !== undefined) parts.push(`${indent}   Line ${issue.lineNumber}`);
          console.log(parts.join("\n") + "\n");
        }
      }
      console.log(sep);
      const { errors, warnings, infos } = result.summary;
      const safeLabel = result.safe ? "SAFE" : "UNSAFE";
      console.log(
        `Result: ${safeLabel} — ${errors} error${errors !== 1 ? "s" : ""}, ${warnings} warning${warnings !== 1 ? "s" : ""}, ${infos} info${infos !== 1 ? "s" : ""}\n`
      );
      if (!migrationConn) {
        console.log("Run with a connection string for more accurate row count estimates.\n");
      }
    }

    // --ci annotations
    if (ci) {
      for (const issue of result.issues) {
        const level = issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "notice";
        const loc = issue.lineNumber ? `,line=${issue.lineNumber}` : "";
        const file = `file=${filePath}${loc}`;
        console.log(`::${level} ${file}::${issue.message}`);
      }
    }

    process.exit(result.safe ? 0 : 1);
  } catch (err: any) {
    if (pool) await pool.end().catch(() => {});
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
} else if (subcommand === "schema-diff") {
  // Schema diff mode
  const connectionString = resolveConnectionString(1);
  const format = values.format || "text";
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

  if (format === "json") {
    console.log(JSON.stringify(changes.map((c) => ({
      type: c.change_type,
      objectType: c.object_type,
      objectName: c.object_name,
      tableName: c.table_name,
      detail: c.detail,
      timestamp: c.timestamp,
    })), null, 2));
  } else {
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
  }
  process.exit(0);
} else if (subcommand === "diff-env") {
  // Multi-environment schema + health diff
  const sourceUrl = values.source;
  const targetUrl = values.target;
  if (!sourceUrl || !targetUrl) {
    console.error("Error: diff-env requires --source <url> and --target <url>");
    process.exit(1);
  }
  const format = values.format || "text";
  const includeHealth = values.health || false;
  const ci = values.ci || false;

  const { diffEnvironments, formatTextDiff, formatMdDiff } = await import("./server/env-differ.js");

  try {
    const result = await diffEnvironments(sourceUrl, targetUrl, { includeHealth });

    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else if (format === "md") {
      console.log(formatMdDiff(result));
    } else {
      // text (default)
      const text = formatTextDiff(result);
      console.log(text);
      if (ci) {
        // GitHub Actions annotations — severity matches impact
        for (const t of result.schema.missingTables) {
          console.log(`::error::diff-env: target missing table: ${t}`);
        }
        for (const t of result.schema.extraTables) {
          console.log(`::notice::diff-env: target has extra table: ${t}`);
        }
        for (const cd of result.schema.columnDiffs) {
          for (const col of cd.missingColumns) {
            console.log(`::error::diff-env: target missing column: ${cd.table}.${col.name} (${col.type})`);
          }
          for (const col of cd.extraColumns) {
            console.log(`::notice::diff-env: target has extra column: ${cd.table}.${col.name} (${col.type})`);
          }
          for (const td of cd.typeDiffs) {
            console.log(`::error::diff-env: type mismatch: ${cd.table}.${td.column} ${td.sourceType}→${td.targetType}`);
          }
        }
        for (const id of result.schema.indexDiffs) {
          for (const idx of id.missingIndexes) {
            console.log(`::warning::diff-env: target missing index: ${id.table}.${idx}`);
          }
          for (const idx of id.extraIndexes) {
            console.log(`::notice::diff-env: target has extra index: ${id.table}.${idx}`);
          }
        }
        for (const c of result.schema.constraintDiffs ?? []) {
          const level = c.type === "missing" ? "error" : c.type === "extra" ? "notice" : "warning";
          console.log(`::${level}::diff-env: constraint ${c.type}: ${c.detail}`);
        }
        for (const e of result.schema.enumDiffs ?? []) {
          const level = e.type === "missing" ? "error" : e.type === "extra" ? "notice" : "warning";
          console.log(`::${level}::diff-env: enum ${e.type}: ${e.detail}`);
        }
      }
    }

    process.exit(result.summary.identical ? 0 : 1);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
} else if (subcommand === "explain") {
  // Usage: pg-dash explain "<query>" <connection> [--no-analyze] [--json]
  const query = positionals[1];
  if (!query) {
    console.error('Error: provide a SQL query.\n\nUsage: pg-dash explain "<query>" <connection>');
    process.exit(1);
  }
  const connStr = positionals[2] || resolveConnectionString(2);
  if (!connStr) {
    console.error("Error: provide a connection string.");
    process.exit(1);
  }

  const doAnalyze = !values["no-analyze"];
  const fmt = values.json ? "json" : "text";

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: connStr, max: 1, connectionTimeoutMillis: 10000 });

  try {
    const explainSql = doAnalyze
      ? `EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT JSON) ${query}`
      : `EXPLAIN (COSTS, VERBOSE, FORMAT JSON) ${query}`;
    const res = await pool.query(explainSql);
    await pool.end();

    const rawPlan = res.rows[0]["QUERY PLAN"];
    const planObj = Array.isArray(rawPlan) ? rawPlan[0] : rawPlan;
    const root = planObj.Plan;
    const planningTime: number | undefined = planObj["Planning Time"];
    const executionTime: number | undefined = planObj["Execution Time"];

    // ── tree renderer ──────────────────────────────────────────────────────────
    function nodeColor(type: string, rows: number, analyzed: boolean): string {
      if (type.includes("Seq Scan")) return analyzed && rows >= 1000 ? "\x1b[31m\x1b[1m" : "\x1b[31m";
      if (type.includes("Index")) return "\x1b[32m";
      if (type === "Hash Join" || type === "Hash") return "\x1b[33m";
      if (type === "Sort") return "\x1b[35m";
      return "\x1b[37m";
    }
    const reset = "\x1b[0m";
    const dim = "\x1b[2m";
    const cyan = "\x1b[36m";

    function renderNode(node: any, indent = 0, isLast = true): string {
      const lines: string[] = [];
      const prefix = indent === 0 ? "" : "  ".repeat(indent - 1) + (isLast ? "└─ " : "├─ ");
      const analyzed = node["Actual Total Time"] !== undefined;
      const rows = node["Actual Rows"] ?? node["Plan Rows"];
      const color = nodeColor(node["Node Type"], rows, analyzed);
      const rel = node["Relation Name"] ? ` on ${dim}${node["Alias"] || node["Relation Name"]}${reset}` : "";
      const cost = `${dim}cost=${node["Startup Cost"].toFixed(2)}..${node["Total Cost"].toFixed(2)}${reset}`;
      const timing = analyzed ? ` ${cyan}actual=${node["Actual Total Time"].toFixed(3)}ms${reset}` : "";
      const rowStr = analyzed
        ? ` ${dim}rows=${node["Actual Rows"]}/${node["Plan Rows"]}${reset}`
        : ` ${dim}rows=${node["Plan Rows"]}${reset}`;
      const idx = node["Index Name"] ? ` ${dim}idx=${node["Index Name"]}${reset}` : "";
      const filter = node["Filter"] ? ` ${dim}filter=${String(node["Filter"]).slice(0, 40)}${reset}` : "";
      lines.push(`${prefix}${color}${node["Node Type"]}${reset}${rel} ${cost}${timing}${rowStr}${idx}${filter}`);
      if (node.Plans?.length) {
        for (let i = 0; i < node.Plans.length; i++) {
          lines.push(renderNode(node.Plans[i], indent + 1, i === node.Plans.length - 1));
        }
      }
      return lines.join("\n");
    }

    // ── summary ────────────────────────────────────────────────────────────────
    function collectNodes(n: any): any[] {
      return [n, ...(n.Plans?.flatMap(collectNodes) ?? [])];
    }
    const allNodes = collectNodes(root);
    const seqScans = allNodes.filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"]).map((n) => n["Relation Name"] as string);
    const recs: string[] = [];
    for (const n of allNodes) {
      const rows = n["Actual Rows"] ?? n["Plan Rows"];
      if (n["Node Type"] === "Seq Scan" && n["Relation Name"] && rows >= 1000) {
        recs.push(`⚠  Seq Scan on "${n["Relation Name"]}" (${rows} rows). Consider adding an index.`);
      }
      if (n["Node Type"] === "Sort") {
        recs.push(`ℹ  Sort on [${(n["Sort Key"] ?? []).join(", ")}]. An index might eliminate this.`);
      }
      if (n["Hash Batches"] && n["Hash Batches"] > 1) {
        recs.push(`⚠  Hash Join used ${n["Hash Batches"]} batches. Increase work_mem to avoid disk spilling.`);
      }
    }

    if (fmt === "json") {
      console.log(JSON.stringify({ query, planningTime, executionTime, seqScans, recommendations: recs }, null, 2));
    } else {
      if (query) console.log(`\n\x1b[1mQuery:\x1b[0m ${dim}${query.slice(0, 120)}${reset}`);
      console.log("\n" + renderNode(root));
      console.log(`\n${dim}─── Summary ${"─".repeat(36)}${reset}`);
      if (executionTime !== undefined) console.log(`  Execution time:  ${cyan}${executionTime.toFixed(3)}ms${reset}`);
      if (planningTime !== undefined) console.log(`  Planning time:   ${dim}${planningTime.toFixed(3)}ms${reset}`);
      if (seqScans.length > 0) console.log(`  Seq Scans:       \x1b[31m${seqScans.join(", ")}${reset}`);
      if (recs.length > 0) {
        console.log(`\n${dim}─── Recommendations ${"─".repeat(28)}${reset}`);
        for (const r of recs) console.log(`  ${r}`);
      }
      console.log();
    }
  } catch (err: any) {
    await pool.end().catch(() => {});
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);

} else if (subcommand === "watch-locks") {
  // Usage: pg-dash watch-locks <connection> [--interval 3]
  const connStr = positionals[1] || resolveConnectionString(1);
  if (!connStr) {
    console.error("Error: provide a connection string.\n\nUsage: pg-dash watch-locks <connection>");
    process.exit(1);
  }

  const intervalSec = values.interval ? parseInt(values.interval, 10) : 3;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: connStr, max: 2, connectionTimeoutMillis: 10000 });
  const { getLockReport } = await import("./server/locks.js");

  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";
  const cyan = "\x1b[36m";
  const bold = "\x1b[1m";

  process.stdout.write("\x1b[?25l"); // hide cursor
  const cleanup = () => { process.stdout.write("\x1b[?25h"); pool.end(); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  async function tick() {
    try {
      const report = await getLockReport(pool);
      console.clear();
      const ts = new Date().toLocaleTimeString();
      console.log(`${bold}pg-dash watch-locks${reset}  ${dim}(Ctrl+C to exit — refresh every ${intervalSec}s — ${ts})${reset}\n`);

      if (report.waitingLocks.length === 0) {
        console.log(`  ${dim}No lock waits detected.${reset}`);
      } else {
        console.log(`${bold}${red}  Lock Waits (${report.waitingLocks.length})${reset}`);
        for (const lw of report.waitingLocks) {
          console.log(`\n  ${red}BLOCKED${reset} pid=${lw.blockedPid} waiting ${lw.blockedDuration}`);
          console.log(`    Query: ${dim}${lw.blockedQuery.slice(0, 100)}${reset}`);
          console.log(`    ${yellow}BLOCKING${reset} pid=${lw.blockingPid} running ${lw.blockingDuration}`);
          console.log(`    Query: ${dim}${lw.blockingQuery.slice(0, 100)}${reset}`);
          if (lw.table) console.log(`    Table: ${lw.table}  Lock: ${lw.lockType}`);
        }
      }

      if (report.longRunningQueries.length > 0) {
        console.log(`\n${bold}${yellow}  Long-running Queries (${report.longRunningQueries.length})${reset}`);
        for (const q of report.longRunningQueries) {
          console.log(`\n  pid=${q.pid}  duration=${q.duration}  state=${q.state}`);
          console.log(`  ${dim}${q.query.slice(0, 120)}${reset}`);
        }
      }

      if (report.waitingLocks.length === 0 && report.longRunningQueries.length === 0) {
        console.log(`\n  ${dim}No long-running queries.${reset}`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
    }
  }

  await tick();
  const timer = setInterval(tick, intervalSec * 1000);
  void timer; // keep running

} else {
  // Check for unknown subcommands before treating positional as connection string
  if (subcommand && !isValidConnectionString(subcommand) && KNOWN_SUBCOMMANDS.indexOf(subcommand) === -1) {
    console.error(
      `Error: Unknown subcommand "${subcommand}".\n\n` +
      `Known subcommands: ${KNOWN_SUBCOMMANDS.join(", ")}\n` +
      `Run pg-dash --help for usage.`
    );
    process.exit(1);
  }

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
