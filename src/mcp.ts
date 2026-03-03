#!/usr/bin/env node
// MCP Server for pg-dash — exposes PostgreSQL monitoring tools

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Pool } from "pg";
import { z } from "zod";
import { getOverview } from "./server/queries/overview.js";
import { getTables } from "./server/queries/tables.js";
import { getSchemaTableDetail } from "./server/queries/schema.js";
import { getActivity } from "./server/queries/activity.js";
import { getAdvisorReport, isSafeFix } from "./server/advisor.js";
import { getSlowQueries } from "./server/queries/slow-queries.js";
import { saveSnapshot, loadSnapshot, diffSnapshots } from "./server/snapshot.js";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs, { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

const connString = process.argv[2] || process.env.PG_DASH_CONNECTION_STRING;
if (!connString) {
  console.error("Usage: pg-dash-mcp <connection-string>");
  console.error("  or set PG_DASH_CONNECTION_STRING env var");
  process.exit(1);
}

const pool = new Pool({ connectionString: connString });
const longQueryThreshold = parseInt(process.env.PG_DASH_LONG_QUERY_THRESHOLD || "5", 10);
const dataDir = process.env.PG_DASH_DATA_DIR || path.join(os.homedir(), ".pg-dash");
fs.mkdirSync(dataDir, { recursive: true });

// Open schema and alerts DBs (read-only for history queries)
let schemaDb: Database.Database | null = null;
let alertsDb: Database.Database | null = null;
try {
  const schemaPath = path.join(dataDir, "schema.db");
  if (fs.existsSync(schemaPath)) schemaDb = new Database(schemaPath, { readonly: true });
} catch (err) { console.error("[mcp] Error:", (err as Error).message); }
try {
  const alertsPath = path.join(dataDir, "alerts.db");
  if (fs.existsSync(alertsPath)) alertsDb = new Database(alertsPath, { readonly: true });
} catch (err) { console.error("[mcp] Error:", (err as Error).message); }

const server = new McpServer({ name: "pg-dash", version: pkg.version });

server.tool("pg_dash_overview", "Get database overview (version, uptime, size, connections)", {}, async () => {
  try {
    const data = await getOverview(pool);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_health", "Get health advisor report with score, grade, and issues", {}, async () => {
  try {
    const data = await getAdvisorReport(pool, longQueryThreshold);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_tables", "List all tables with sizes and row counts", {}, async () => {
  try {
    const data = await getTables(pool);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_table_detail", "Get detailed info about a specific table", { table: z.string().describe("Table name (e.g. 'users' or 'public.users')") }, async ({ table }) => {
  try {
    const data = await getSchemaTableDetail(pool, table);
    if (!data) return { content: [{ type: "text", text: "Table not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_activity", "Get current database activity (active queries, connections)", {}, async () => {
  try {
    const data = await getActivity(pool);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_schema_changes", "Get recent schema changes", {}, async () => {
  try {
    if (!schemaDb) return { content: [{ type: "text", text: "No schema tracking data available. Run pg-dash server first." }] };
    const changes = schemaDb.prepare("SELECT * FROM schema_changes ORDER BY timestamp DESC LIMIT 50").all();
    return { content: [{ type: "text", text: JSON.stringify(changes, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_fix", "Execute a safe fix (VACUUM, ANALYZE, REINDEX, etc.)", { sql: z.string().describe("SQL to execute (must be a safe operation)") }, async ({ sql }) => {
  try {
    if (!isSafeFix(sql)) return { content: [{ type: "text", text: "Operation not allowed. Only VACUUM, ANALYZE, REINDEX, CREATE/DROP INDEX CONCURRENTLY, pg_terminate_backend, pg_cancel_backend, and EXPLAIN ANALYZE are permitted." }], isError: true };
    const client = await pool.connect();
    try {
      const start = Date.now();
      const result = await client.query(sql);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, duration: Date.now() - start, rowCount: result.rowCount, rows: result.rows || [] }, null, 2) }] };
    } finally {
      client.release();
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_alerts", "Get alert history", {}, async () => {
  try {
    if (!alertsDb) return { content: [{ type: "text", text: "No alerts data available. Run pg-dash server first." }] };
    const history = alertsDb.prepare("SELECT * FROM alert_history ORDER BY timestamp DESC LIMIT 50").all();
    return { content: [{ type: "text", text: JSON.stringify(history, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// --- New tools ---

server.tool("pg_dash_explain", "Run EXPLAIN ANALYZE on a SELECT query (read-only, wrapped in BEGIN/ROLLBACK)", { query: z.string().describe("SELECT query to explain") }, async ({ query }) => {
  try {
    if (!/^\s*SELECT\b/i.test(query)) return { content: [{ type: "text", text: "Error: Only SELECT queries are allowed" }], isError: true };
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '30s'");
      await client.query("BEGIN");
      try {
        const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
        await client.query("ROLLBACK");
        await client.query("RESET statement_timeout");
        return { content: [{ type: "text", text: JSON.stringify(r.rows[0]["QUERY PLAN"], null, 2) }] };
      } catch (err: any) {
        await client.query("ROLLBACK").catch(() => {});
        await client.query("RESET statement_timeout").catch(() => {});
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    } finally {
      client.release();
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_batch_fix", "Get batch fix SQL for issues (optionally filtered by category)", { category: z.string().optional().describe("Filter by issue type prefix, e.g. 'schema-missing-fk-index'") }, async ({ category }) => {
  try {
    const report = await getAdvisorReport(pool, longQueryThreshold);
    let fixes = report.batchFixes;
    if (category) fixes = fixes.filter((f) => f.type.startsWith(category));
    if (fixes.length === 0) return { content: [{ type: "text", text: "No batch fixes found" + (category ? ` for category '${category}'` : "") }] };
    const combined = fixes.map((f) => `-- ${f.title}\n${f.sql}`).join("\n\n");
    return { content: [{ type: "text", text: combined }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_slow_queries", "Get top slow queries from pg_stat_statements", {
  limit: z.number().optional().default(20).describe("Max queries to return (default 20)"),
  orderBy: z.enum(["total_time", "mean_time", "calls"]).optional().default("total_time").describe("Sort order"),
}, async ({ limit, orderBy }) => {
  try {
    const all = await getSlowQueries(pool);
    if (all.length === 0) return { content: [{ type: "text", text: "No slow query data available. pg_stat_statements may not be installed." }] };
    const sorted = [...all].sort((a, b) => (b as any)[orderBy] - (a as any)[orderBy]);
    return { content: [{ type: "text", text: JSON.stringify(sorted.slice(0, limit), null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_table_sizes", "Get table sizes with data/index breakdown (top 30)", {}, async () => {
  try {
    const client = await pool.connect();
    try {
      const r = await client.query(`
        SELECT schemaname, relname,
               pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as total_size,
               pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as table_size,
               pg_indexes_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as index_size
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) DESC
        LIMIT 30
      `);
      const tables = r.rows.map((row: any) => ({
        schema: row.schemaname,
        name: row.relname,
        totalSize: parseInt(row.total_size),
        tableSize: parseInt(row.table_size),
        indexSize: parseInt(row.index_size),
      }));
      return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
    } finally {
      client.release();
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_export", "Export full health report", { format: z.enum(["json", "md"]).optional().default("json").describe("Output format: json or md") }, async ({ format }) => {
  try {
    const [overview, advisor] = await Promise.all([
      getOverview(pool),
      getAdvisorReport(pool, longQueryThreshold),
    ]);
    if (format === "md") {
      const lines: string[] = [];
      lines.push(`# pg-dash Health Report`);
      lines.push(`\nGenerated: ${new Date().toISOString()}\n`);
      lines.push(`## Overview\n`);
      lines.push(`- **PostgreSQL**: ${overview.version}`);
      lines.push(`- **Database Size**: ${overview.dbSize}`);
      lines.push(`- **Connections**: ${overview.connections.active} active / ${overview.connections.idle} idle / ${overview.connections.max} max`);
      lines.push(`\n## Health Score: ${advisor.score}/100 (Grade: ${advisor.grade})\n`);
      lines.push(`| Category | Grade | Score | Issues |`);
      lines.push(`|----------|-------|-------|--------|`);
      for (const [cat, b] of Object.entries(advisor.breakdown)) {
        lines.push(`| ${cat} | ${b.grade} | ${b.score}/100 | ${b.count} |`);
      }
      if (advisor.issues.length > 0) {
        lines.push(`\n### Issues (${advisor.issues.length})\n`);
        for (const issue of advisor.issues) {
          const icon = issue.severity === "critical" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
          lines.push(`- ${icon} [${issue.severity}] ${issue.title}`);
        }
      }
      if (advisor.batchFixes.length > 0) {
        lines.push(`\n### 🔧 Batch Fixes\n`);
        for (const fix of advisor.batchFixes) {
          lines.push(`\`\`\`sql\n${fix.sql}\n\`\`\`\n`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ overview, advisor, exportedAt: new Date().toISOString() }, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_diff", "Compare current health with last saved snapshot", {}, async () => {
  try {
    const prev = loadSnapshot(dataDir);
    const current = await getAdvisorReport(pool, longQueryThreshold);
    if (!prev) {
      saveSnapshot(dataDir, current);
      return { content: [{ type: "text", text: JSON.stringify({ message: "No previous snapshot found. Current result saved as baseline.", score: current.score, grade: current.grade, issues: current.issues.length }, null, 2) }] };
    }
    const diff = diffSnapshots(prev.result, current);
    saveSnapshot(dataDir, current);
    return { content: [{ type: "text", text: JSON.stringify({ ...diff, previousTimestamp: prev.timestamp }, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
