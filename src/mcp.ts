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
import { diffEnvironments } from "./server/env-differ.js";
import { analyzeExplainPlan, detectQueryRegressions } from "./server/query-analyzer.js";
import { analyzeMigration } from "./server/migration-checker.js";
import { getUnusedIndexes } from "./server/unused-indexes.js";
import { getBloatReport } from "./server/bloat.js";
import { getAutovacuumReport } from "./server/autovacuum.js";
import { getLockReport } from "./server/locks.js";
import { getConfigReport } from "./server/config-checker.js";
import { getDbContext } from "./server/queries/db-context.js";
import { gradeFromScore } from "./server/advisor.js";
import { executeNaturalQuery, getLLMConfig, generateAISuggestions } from "./server/llm.js";
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

const pool = new Pool({ connectionString: connString, connectionTimeoutMillis: 10000 });
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

let queryStatsDb: Database.Database | null = null;
try {
  const queryStatsPath = path.join(dataDir, "query-stats.db");
  if (fs.existsSync(queryStatsPath)) queryStatsDb = new Database(queryStatsPath, { readonly: true });
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
    const snapshotPath = path.join(dataDir, "last-check.json");
    const prev = loadSnapshot(snapshotPath);
    const current = await getAdvisorReport(pool, longQueryThreshold);
    if (!prev) {
      saveSnapshot(snapshotPath, current);
      return { content: [{ type: "text", text: JSON.stringify({ message: "No previous snapshot found. Current result saved as baseline.", score: current.score, grade: current.grade, issues: current.issues.length }, null, 2) }] };
    }
    const diff = diffSnapshots(prev.result, current);
    saveSnapshot(snapshotPath, current);
    return { content: [{ type: "text", text: JSON.stringify({ ...diff, previousTimestamp: prev.timestamp }, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool(
  "pg_dash_check_migration",
  "Analyze migration SQL for safety risks (lock tables, missing tables, destructive ops)",
  {
    sql: z.string().describe("Migration SQL content to analyze"),
  },
  async ({ sql }) => {
    try {
      const result = await analyzeMigration(sql, pool);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "pg_dash_analyze_query",
  "Deep analysis of a SQL query: runs EXPLAIN ANALYZE, detects missing indexes, and provides specific optimization recommendations",
  {
    sql: z.string().describe("SELECT query to analyze"),
  },
  async ({ sql }) => {
    try {
      if (!/^\s*SELECT\b/i.test(sql)) {
        return { content: [{ type: "text", text: "Error: Only SELECT queries are allowed" }], isError: true };
      }
      const client = await pool.connect();
      try {
        await client.query("SET statement_timeout = '30s'");
        await client.query("BEGIN");
        try {
          const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
          await client.query("ROLLBACK");
          await client.query("RESET statement_timeout");

          const plan = r.rows[0]["QUERY PLAN"];
          const analysis = await analyzeExplainPlan(plan, pool);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({ plan, analysis }, null, 2),
            }],
          };
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
  }
);

server.tool(
  "pg_dash_query_regressions",
  "Detect queries that have gotten significantly slower (>50% degradation) compared to historical baselines",
  {
    windowHours: z.number().optional().describe("Hours to look back (default: 24)"),
  },
  async ({ windowHours }) => {
    try {
      const regressions = await detectQueryRegressions(pool, queryStatsDb, windowHours ?? 24);
      if (regressions.length === 0) {
        return { content: [{ type: "text", text: "No query regressions detected in the specified window." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(regressions, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "pg_dash_compare_env",
  "Compare schema and health between two PostgreSQL environments. Detects missing tables, columns, indexes.",
  {
    targetUrl: z.string().describe("Target database connection string to compare against"),
    includeHealth: z.boolean().optional().describe("Also compare health scores and issues"),
  },
  async ({ targetUrl, includeHealth }) => {
    try {
      // source uses the existing pool's connection string; target gets its own pool (created inside diffEnvironments)
      // We pass connString so the source pool is created fresh with a 10s timeout; existing pool is unaffected
      const result = await diffEnvironments(connString, targetUrl, { includeHealth: includeHealth ?? false });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool("pg_dash_unused_indexes", "Find unused indexes that waste space and slow down writes", {}, async () => {
  try {
    const report = await getUnusedIndexes(pool);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_bloat", "Detect table bloat (dead tuples) that slow down queries", {}, async () => {
  try {
    const report = await getBloatReport(pool);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_autovacuum", "Check autovacuum health — which tables are stale or never vacuumed", {}, async () => {
  try {
    const report = await getAutovacuumReport(pool);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_locks", "Show active lock waits and long-running queries blocking the database", {}, async () => {
  try {
    const report = await getLockReport(pool);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("pg_dash_config_check", "Audit PostgreSQL configuration settings and get tuning recommendations", {}, async () => {
  try {
    const report = await getConfigReport(pool);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool(
  "fetch_db_context",
  "Get comprehensive database context for AI agents: table structures, columns, types, primary/foreign keys, indexes, business intent inference, and health summary",
  {},
  async () => {
    try {
      // Get db context (tables, columns, indexes, constraints)
      const dbContext = await getDbContext(pool);
      
      // Get health report for summary
      const healthReport = await getAdvisorReport(pool, longQueryThreshold);
      
      // Build comprehensive response
      const result = {
        // Database overview
        database: dbContext.database,
        
        // Tables with full structure
        tables: dbContext.tables.map(table => ({
          schema: table.schema,
          name: table.name,
          description: table.description,
          rowCount: table.rowCount,
          totalSize: table.totalSize,
          businessIntent: table.businessIntent,
          columnCount: table.columns.length,
          columns: table.columns.map(col => ({
            name: col.name,
            type: col.type,
            nullable: col.nullable,
            isPrimaryKey: col.isPrimaryKey,
            isForeignKey: col.isForeignKey,
            references: col.isForeignKey ? {
              table: col.referencedTable,
              column: col.referencedColumn,
            } : null,
          })),
          primaryKeys: table.primaryKeys,
          foreignKeys: table.foreignKeys,
          indexCount: table.indexes.length,
        })),
        
        // Index summary per table
        indexSummary: dbContext.indexSummary,
        
        // Health summary
        health: {
          score: healthReport.score,
          grade: healthReport.grade,
          categoryScores: Object.fromEntries(
            Object.entries(healthReport.breakdown).map(([cat, data]) => [cat, { grade: data.grade, score: data.score }])
          ),
          issueCount: healthReport.issues.length,
          criticalIssues: healthReport.issues.filter(i => i.severity === "critical").length,
          warningIssues: healthReport.issues.filter(i => i.severity === "warning").length,
          topIssues: healthReport.issues.slice(0, 5).map(i => ({
            severity: i.severity,
            title: i.title,
            category: i.category,
          })),
        },
        
        // Metadata
        generatedAt: new Date().toISOString(),
        version: pkg.version,
      };
      
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- Natural Language Query Tool ---
server.tool(
  "pg_dash_query_natural",
  "Query database using natural language. The LLM converts your question to SQL and returns results. Example: 'show me slow queries last hour', 'find missing indexes', 'what's the health score', 'list all tables with their sizes'",
  {
    query: z.string().describe("Natural language query (e.g., 'show me the top 10 largest tables')"),
    includeSql: z.boolean().optional().default(true).describe("Include the generated SQL in the response"),
  },
  async ({ query, includeSql }) => {
    const llmConfig = getLLMConfig();
    
    // Check if LLM is configured
    if (!llmConfig.apiKey) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "LLM not configured",
            message: "Please set PG_DASH_LLM_API_KEY environment variable (or OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY)",
            usage: {
              openai: "export PG_DASH_LLM_PROVIDER=openai && export PG_DASH_LLM_API_KEY=sk-...",
              anthropic: "export PG_DASH_LLM_PROVIDER=anthropic && export ANTHROPIC_API_KEY=sk-ant-...",
              google: "export PG_DASH_LLM_PROVIDER=google && export GOOGLE_API_KEY=...",
              ollama: "export PG_DASH_LLM_PROVIDER=ollama && export PG_DASH_LLM_BASE_URL=http://localhost:11434",
            },
            provider: llmConfig.provider,
            model: llmConfig.model || "default",
          }, null, 2)
        }],
        isError: true
      };
    }

    try {
      const result = await executeNaturalQuery(pool, query, llmConfig);
      
      if (result.error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: result.error,
              generatedSql: includeSql ? result.sql : undefined,
              message: "Failed to execute natural language query"
            }, null, 2)
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            answer: result.answer,
            generatedSql: includeSql ? result.sql : undefined,
            rowCount: result.result?.rowCount,
            columns: result.result?.columns,
            data: result.result?.rows,
          }, null, 2)
        }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// --- CI Health Summary Tool ---
server.tool(
  "ci_health_summary",
  "Generate a CI-friendly health summary with AI-powered prioritization. Input: health check result (from pg_dash_health). Output: one-sentence summary + prioritized issue list. Perfect for GitHub Actions/GitLab CI integration.",
  {
    healthReport: z.string().describe("JSON string of health report from pg_dash_health tool"),
  },
  async ({ healthReport }) => {
    try {
      const report = JSON.parse(healthReport);
      
      if (!report.score || !report.issues) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Invalid health report format",
              message: "Provide the JSON output from pg_dash_health tool"
            }, null, 2)
          }],
          isError: true
        };
      }

      const llmConfig = getLLMConfig();
      const aiResult = await generateAISuggestions(report, llmConfig);

      // Build CI-friendly output
      const summary = {
        // One-sentence summary
        summary: aiResult.summary,
        // Health score
        score: report.score,
        grade: report.grade,
        // Prioritized issues (already sorted by severity)
        prioritizedIssues: aiResult.suggestions.map((s, idx) => ({
          priority: idx + 1,
          severity: s.priority,
          issue: s.issue,
          suggestion: s.suggestion,
        })),
        // Metadata
        totalIssues: report.issues.length,
        criticalCount: report.issues.filter((i: any) => i.severity === "critical").length,
        warningCount: report.issues.filter((i: any) => i.severity === "warning").length,
        // For CI exit code guidance
        wouldFailCheck: report.score < 70,
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(summary, null, 2)
        }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
