# MCP Setup Guide: pg-dash with Claude Desktop and Cursor

Connect pg-dash to your AI coding assistant and talk to your database in plain English. No more copy-pasting connection strings into chat — your AI has direct access to 23 database tools.

## What Is MCP?

MCP (Model Context Protocol) lets AI assistants call external tools. pg-dash ships an MCP server with 23 tools covering health checks, query analysis, schema inspection, migration safety, and more.

Once connected, you can ask Claude or Cursor things like "which tables have the most bloat?" and it will query your database directly and give you a real answer.

## Setup

### Claude Desktop (macOS/Windows)

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pg-dash": {
      "command": "npx",
      "args": ["-y", "-p", "@indiekitai/pg-dash", "pg-dash-mcp", "postgresql://user:pass@host/db"]
    }
  }
}
```

Replace `postgresql://user:pass@host/db` with your actual connection string.

**Restart Claude Desktop** after saving the config. You'll see a 🔌 icon in the chat input area when MCP tools are connected.

### Cursor

Add `.cursor/mcp.json` to your project root (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "pg-dash": {
      "command": "npx",
      "args": ["-y", "-p", "@indiekitai/pg-dash", "pg-dash-mcp", "postgresql://user:pass@host/db"]
    }
  }
}
```

Cursor picks up MCP config automatically. You can verify it's working via **Settings → MCP**.

### Using an Environment Variable

If you'd rather not put credentials in a config file:

```json
{
  "mcpServers": {
    "pg-dash": {
      "command": "npx",
      "args": ["-y", "-p", "@indiekitai/pg-dash", "pg-dash-mcp"],
      "env": {
        "PG_DASH_CONNECTION_STRING": "postgresql://user:pass@host/db"
      }
    }
  }
}
```

### Multiple Databases

You can connect pg-dash to multiple databases simultaneously — just give each a unique key:

```json
{
  "mcpServers": {
    "pg-dash-prod": {
      "command": "npx",
      "args": ["-y", "-p", "@indiekitai/pg-dash", "pg-dash-mcp", "postgresql://user:pass@prod-host/db"]
    },
    "pg-dash-staging": {
      "command": "npx",
      "args": ["-y", "-p", "@indiekitai/pg-dash", "pg-dash-mcp", "postgresql://user:pass@staging-host/db"]
    }
  }
}
```

## What You Can Ask Your AI

Once connected, your AI assistant has live access to your database. Here are 10 prompts that work well:

1. **"Which indexes on this database have never been used?"**  
   Finds indexes with 0 scans since the last stats reset — pure write overhead with no read benefit.

2. **"Is my autovacuum healthy? Which tables are overdue?"**  
   Checks each table's last vacuum time and classifies them as `ok`, `stale`, `overdue`, or `never`.

3. **"Check this migration file for lock risks: [paste SQL]"**  
   Runs the migration safety analyzer inline. Paste your SQL, get a risk assessment in seconds.

4. **"Compare the schema between staging and production"**  
   Uses `pg_dash_compare_env` to find missing tables, columns, indexes, and type mismatches between environments.

5. **"What PostgreSQL config changes would improve performance?"**  
   Audits `shared_buffers`, `work_mem`, `checkpoint_completion_target`, `random_page_cost`, and more. Returns severity-tagged recommendations with exact values.

6. **"Show me the slowest queries from the last 24 hours"**  
   Queries `pg_stat_statements` for top offenders by mean execution time. Requires `pg_stat_statements` extension.

7. **"Are there any tables with high bloat?"**  
   Finds tables where dead tuples exceed 10% of total — a sign that VACUUM isn't keeping up.

8. **"What's the current health score of my database?"**  
   Runs the full 46-check health advisor and returns a score, grade (A–F), and prioritized issue list.

9. **"Are there any lock waits right now?"**  
   Shows active lock-wait chains — who's blocking whom and for how long. Useful when a deployment is stuck.

10. **"Export a full health report as Markdown"**  
    Generates a complete report you can paste into Notion, Linear, a PR comment, or a Slack post.

## Available Tools (23)

| Tool | What It Does |
|------|-------------|
| `pg_dash_health` | Health score, grade, and all issues |
| `pg_dash_overview` | Version, uptime, size, connection count |
| `pg_dash_tables` | All tables with sizes and row counts |
| `pg_dash_table_detail` | Deep info on a specific table |
| `pg_dash_activity` | Active queries and connections |
| `pg_dash_slow_queries` | Top slow queries from `pg_stat_statements` |
| `pg_dash_explain` | `EXPLAIN ANALYZE` on any SELECT |
| `pg_dash_analyze_query` | Deep EXPLAIN with automatic index suggestions |
| `pg_dash_query_regressions` | Queries that degraded >50% vs baseline |
| `pg_dash_schema_changes` | Recent schema changes (table/column/index diffs) |
| `pg_dash_diff` | Health diff vs last saved snapshot |
| `pg_dash_check_migration` | Migration SQL safety analysis |
| `pg_dash_compare_env` | Schema + health diff between two environments |
| `pg_dash_unused_indexes` | Indexes with 0 scans since stats reset |
| `pg_dash_bloat` | Tables with high dead tuple ratio |
| `pg_dash_autovacuum` | Autovacuum health per table |
| `pg_dash_locks` | Active lock waits and blocking queries |
| `pg_dash_config_check` | PostgreSQL config audit + recommendations |
| `pg_dash_table_sizes` | Top 30 tables by size (data + index breakdown) |
| `pg_dash_fix` | Execute a safe fix (VACUUM, ANALYZE, REINDEX) |
| `pg_dash_batch_fix` | Get batch SQL to fix multiple issues at once |
| `pg_dash_alerts` | Alert history |
| `pg_dash_export` | Export full report as JSON or Markdown |

## Tips

**Ask follow-up questions.** Your AI can chain tools. Start with "what's wrong with my database?" and follow up with "generate the SQL to fix all the missing FK indexes."

**The AI can't modify your schema.** For safety, the only write operations allowed via MCP are `VACUUM`, `ANALYZE`, `REINDEX`, and similar maintenance commands. No `DROP`, `ALTER`, or `INSERT`.

**Use it before deploys.** Ask "run a health check and tell me if there are any active lock waits" before pushing a major migration.

**Combine with `diff-env`.** Before promoting staging to prod, ask "compare staging and production schemas and show me what's different."
