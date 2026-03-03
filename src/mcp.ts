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
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

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

const server = new McpServer({ name: "pg-dash", version: "0.1.0" });

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

const transport = new StdioServerTransport();
await server.connect(transport);
