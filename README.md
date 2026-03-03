[English](README.md) | [中文](README.zh-CN.md)

# pg-dash

**The AI-native PostgreSQL health checker.** One command to audit your database, 18 MCP tools for AI-assisted optimization, CI integration for automated checks.

Not another monitoring dashboard — pg-dash is built to fit into your **AI coding workflow**:

```
Developer writes a migration → pg-dash check-migration (pre-flight) →
CI runs pg-dash check → Finds missing indexes →
MCP tool suggests fix → PR comment
```

```bash
# One-shot health check
npx @indiekitai/pg-dash check postgres://user:pass@host/db

# Check migration safety before running it
npx @indiekitai/pg-dash check-migration ./migrations/015_add_index.sql

# Compare two environments (local vs staging)
npx @indiekitai/pg-dash diff-env --source postgres://localhost/db --target postgres://staging/db

# AI assistant (Claude/Cursor) via MCP
pg-dash-mcp postgres://user:pass@host/db

# CI pipeline with diff
npx @indiekitai/pg-dash check $DATABASE_URL --ci --diff --format md
```

## Philosophy

**Developer tools are use-and-go.** You don't stare at a PostgreSQL dashboard all day. You run a check, fix the issues, and move on. pg-dash embraces this:

- **Health check** → Find problems, get actionable SQL fixes, done
- **MCP tools** → Let your AI assistant query and fix your database directly (unique — pganalyze/pgwatch don't have this)
- **CI integration** → Catch issues automatically on every migration, not when production is on fire
- **Smart diff** → See what changed since last run, track your progress

The Dashboard is there when you need it. But the real power is in the CLI, MCP, and CI.

## Why pg-dash?

| Tool | Price | Setup | AI-native | CI-ready |
|------|-------|-------|-----------|----------|
| pganalyze | $149+/mo | SaaS signup | ❌ | ❌ |
| Grafana+Prometheus | Free | 3 services | ❌ | ❌ |
| pgAdmin | Free | Complex UI | ❌ | ❌ |
| **pg-dash** | **Free** | **One command** | **18 MCP tools** | **`--ci --diff`** |

## Features

### 📊 Real-time Monitoring
- Live connection count, TPS, cache hit ratio, DB size
- Time-series charts with range selector (5m → 7d)
- WebSocket-powered auto-refresh
- Active query list with cancel support

### 🏥 Health Advisor
- **46+ automated checks** across performance, maintenance, schema, and security
- A-F health grade with category breakdown
- **One-click fixes** — not just "here's what's wrong" but "click to fix it"
- SQL allowlist (only safe operations: VACUUM, ANALYZE, REINDEX, etc.)

### 📋 Schema Browser
- Browse all tables, columns, indexes, constraints, foreign keys
- Sample data preview
- Index usage stats
- Extension and enum type listing

### 🔄 Schema Change Tracking
- Automatic schema snapshots (every 6 hours)
- Detects: tables added/removed, columns changed, indexes modified
- Timeline view with diff comparison
- The sticky feature — gets more valuable over time

### 🔔 Alerts
- 7 default alert rules (connection utilization, cache ratio, long queries, etc.)
- Custom rules via API
- Cooldown support (no alert spam)
- Webhook notifications
- Alert history

### 🔍 EXPLAIN Plan Visualization
- Click any query in the Queries tab to see its execution plan
- Tree view of the EXPLAIN output for easy analysis

### 📈 Query Time-Series Trends
- Trends tab with historical pg_stat_statements snapshots
- Track query performance over time

### 💾 Disk Space Monitoring
- Disk tab with per-table size breakdown
- Growth prediction using linear regression
- "Days until disk full" estimate

### 📣 Slack & Discord Notifications
- Webhook notifications for alerts
- Auto-detects Slack vs Discord webhook URLs
- Configure via `--slack-webhook` or `--discord-webhook`

### 🛡️ Migration Safety Check
- Analyze a migration SQL file for risks before running it
- Detects: `CREATE INDEX` without `CONCURRENTLY` (lock risk), `ADD COLUMN NOT NULL` without `DEFAULT`, `ALTER COLUMN TYPE` (full table rewrite), `DROP COLUMN` (app breakage risk), `ADD CONSTRAINT` without `NOT VALID` (full table scan), `CREATE INDEX CONCURRENTLY` inside a transaction (runtime failure), `DROP TABLE`, `TRUNCATE`, `DELETE`/`UPDATE` without `WHERE`
- Dynamic checks: connects to DB to verify referenced tables exist, estimates lock time based on actual row counts
- CI-ready: `--ci` flag emits `::error::` / `::warning::` GitHub Actions annotations

### 🧠 Query Intelligence
- `pg_dash_analyze_query` — runs `EXPLAIN ANALYZE`, detects Seq Scans on large tables, auto-generates `CREATE INDEX CONCURRENTLY` suggestions with benefit ratings
- `pg_dash_query_regressions` — finds queries that got >50% slower vs historical baseline (requires `pg_stat_statements`)
- EXPLAIN Modal in dashboard shows index suggestions inline

### 🔄 Multi-Env Diff
- Compare schema and health between two PostgreSQL environments (local vs staging, staging vs prod)
- Detects: missing/extra tables, missing/extra columns, column type mismatches, missing/extra indexes, **foreign key and CHECK constraints**, **enum type differences**
- `--health` flag adds health score comparison and unique issues per environment
- `pg_dash_compare_env` MCP tool: ask your AI "what's different between local and staging?"

### 🤖 MCP Server
- 18 tools for AI agent integration
- `pg-dash-mcp postgres://...` — works with Claude, Cursor, etc.

### 🖥️ CLI
```bash
# Start dashboard
pg-dash postgres://user:pass@host/db

# Health check (great for CI/CD)
pg-dash check postgres://user:pass@host/db
pg-dash check postgres://... --format json --threshold 70

# Migration safety check
pg-dash check-migration ./migrations/015_add_index.sql
pg-dash check-migration ./migrations/015_add_index.sql postgres://... --ci

# Multi-env schema diff
pg-dash diff-env --source postgres://localhost/db --target postgres://staging/db
pg-dash diff-env --source postgres://... --target postgres://... --health --format md

# Schema changes
pg-dash schema-diff postgres://user:pass@host/db
```

## Quick Start

```bash
# Using npx (no install needed)
npx @indiekitai/pg-dash postgres://user:pass@localhost/mydb

# Or install globally
npm install -g @indiekitai/pg-dash
pg-dash postgres://user:pass@localhost/mydb

# With individual options
pg-dash --host localhost --user postgres --db mydb --port 3480
```

Opens your browser at `http://localhost:3480` with the full dashboard.

## CLI Options

```
pg-dash <connection-string>               Start dashboard
pg-dash check <connection-string>         Run health check and exit
pg-dash check-migration <file> [conn]     Analyze migration SQL for risks
pg-dash diff-env --source <url> --target <url>  Compare two environments
pg-dash schema-diff <connection-string>   Show schema changes

Options:
  -p, --port <port>      Dashboard port (default: 3480)
  --no-open              Don't auto-open browser
  --json                 Dump health check as JSON and exit
  --host <host>          PostgreSQL host
  -u, --user <user>      PostgreSQL user
  --password <pass>      PostgreSQL password
  -d, --db <database>    PostgreSQL database
  --pg-port <port>       PostgreSQL port (default: 5432)
  --data-dir <dir>       Data directory (default: ~/.pg-dash)
  -i, --interval <sec>   Collection interval (default: 30)
  --threshold <score>    Score threshold for check command (default: 70)
  -f, --format <fmt>     Output format: text|json|md (default: text)
  --query-stats-interval <min>  Query stats snapshot interval in minutes (default: 5)
  --slack-webhook <url>  Slack webhook URL for alert notifications
  --discord-webhook <url>  Discord webhook URL for alert notifications
  --ci                   Output GitHub Actions annotations (check, check-migration, diff-env)
  --diff                 Compare with last snapshot (check command)
  --snapshot-path <path> Path to snapshot file for --diff
  --health               Include health comparison (diff-env)
  -v, --version          Show version
```

## MCP Server

For AI agent integration:

```bash
# Start MCP server
pg-dash-mcp postgres://user:pass@host/db

# Or with env var
PG_DASH_CONNECTION_STRING=postgres://... pg-dash-mcp
```

### Available Tools (18)

| Tool | Description |
|------|-------------|
| `pg_dash_overview` | Database overview (version, uptime, size, connections) |
| `pg_dash_health` | Health advisor report with score, grade, and issues |
| `pg_dash_tables` | List all tables with sizes and row counts |
| `pg_dash_table_detail` | Detailed info about a specific table |
| `pg_dash_activity` | Current database activity (active queries, connections) |
| `pg_dash_schema_changes` | Recent schema changes |
| `pg_dash_fix` | Execute a safe fix (VACUUM, ANALYZE, REINDEX, etc.) |
| `pg_dash_alerts` | Alert history |
| `pg_dash_explain` | Run EXPLAIN ANALYZE on a SELECT query (read-only) |
| `pg_dash_batch_fix` | Get batch fix SQL for issues, optionally filtered by category |
| `pg_dash_slow_queries` | Top slow queries from pg_stat_statements |
| `pg_dash_table_sizes` | Table sizes with data/index breakdown (top 30) |
| `pg_dash_export` | Export full health report (JSON or Markdown) |
| `pg_dash_diff` | Compare current health with last saved snapshot |
| `pg_dash_check_migration` | Analyze migration SQL for lock risks, missing tables, destructive ops |
| `pg_dash_analyze_query` | Deep EXPLAIN analysis with automatic index suggestions |
| `pg_dash_query_regressions` | Detect queries that degraded >50% vs historical baseline |
| `pg_dash_compare_env` | Compare schema and health between two database environments |

## MCP Setup

Connect pg-dash to Claude Desktop or Cursor for AI-assisted database management.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

### Cursor

Add to `.cursor/mcp.json` in your project:

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

### Example Conversations

Once connected, you can ask your AI assistant:

**Diagnosis:**
- "What's wrong with my database right now?"
- "Why is my `users` table slow? Check for missing indexes."
- "Show me the top 5 slowest queries this week."

**Optimization:**
- "Generate SQL to fix all missing FK indexes in one go."
- "EXPLAIN this query for me: SELECT * FROM orders WHERE user_id = 123"
- "Which tables are taking up the most space?"

**Pre-migration check:**
- "Run a health check and tell me if it's safe to deploy."
- "What changed in the schema since last week?"
- "Check if there are any idle connections blocking my migration."

## CI Integration

### GitHub Actions

Add `--ci` and `--diff` flags to integrate with CI pipelines:

```bash
# GitHub Actions annotations (::error::, ::warning::)
pg-dash check postgres://... --ci

# Markdown report for PR comments
pg-dash check postgres://... --ci --format md

# Compare with previous run
pg-dash check postgres://... --diff

# All together
pg-dash check postgres://... --ci --diff --format md
```

Sample workflow (`.github/workflows/pg-check.yml`):

```yaml
name: Database Health Check
on:
  push:
    paths: ['migrations/**', 'prisma/**', 'drizzle/**', 'supabase/migrations/**']
  pull_request:
    paths: ['migrations/**', 'prisma/**', 'drizzle/**', 'supabase/migrations/**']
  schedule:
    - cron: '0 8 * * 1'  # Weekly Monday 8am UTC
jobs:
  db-health:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Cache snapshot across ephemeral runners for --diff to work
      - name: Restore health snapshot
        uses: actions/cache@v4
        with:
          path: .pg-dash-cache
          key: pg-dash-snapshot-${{ github.ref }}
          restore-keys: pg-dash-snapshot-
      - name: Run pg-dash health check
        id: pg-check
        run: |
          mkdir -p .pg-dash-cache
          npx @indiekitai/pg-dash check ${{ secrets.DATABASE_URL }} \
            --ci --diff --snapshot-path ./.pg-dash-cache/last-check.json \
            --format md > pg-dash-report.md
          echo "exit_code=$?" >> $GITHUB_OUTPUT
        continue-on-error: true
      - name: Save health snapshot
        uses: actions/cache/save@v4
        if: always()
        with:
          path: .pg-dash-cache
          key: pg-dash-snapshot-${{ github.ref }}-${{ github.run_id }}
      - name: Fail if unhealthy
        if: steps.pg-check.outputs.exit_code != '0'
        run: exit 1
```

See [`examples/github-actions-pg-check.yml`](examples/github-actions-pg-check.yml) for a full workflow with PR comments.

## Health Checks

pg-dash runs 46+ automated checks:

**Performance**
- Missing indexes (high sequential scans on large tables)
- Bloated indexes (index size vs table size)
- Table bloat (dead tuple ratio)
- Cache efficiency per table
- Slow queries (from pg_stat_statements)

**Maintenance**
- VACUUM overdue
- ANALYZE overdue
- Transaction ID wraparound risk
- Idle connection detection
- Idle in transaction detection

**Schema**
- Missing primary keys
- Unused indexes (0 scans, >1MB)
- Duplicate indexes
- Missing foreign key indexes

**Security**
- Remote superuser connections
- SSL disabled
- Trust authentication (no password)

## CI/CD Integration

```bash
# Fail pipeline if health score < 70
pg-dash check postgres://... --threshold 70 --format json

# Example GitHub Actions
- name: Database Health Check
  run: npx @indiekitai/pg-dash check ${{ secrets.DATABASE_URL }} --threshold 70
```

## Data Storage

pg-dash stores metrics locally in `~/.pg-dash/`:
- `metrics.db` — Time-series metrics (7-day retention)
- `schema.db` — Schema snapshots and change history
- `alerts.db` — Alert rules and history

All SQLite. No external dependencies. Delete the folder to reset.

## Tech Stack

- **Backend**: Hono + Node.js
- **Frontend**: React + Tailwind CSS (bundled)
- **Storage**: SQLite (better-sqlite3)
- **Charts**: Recharts
- **Zero external services required**

## Requirements

- Node.js 18+
- PostgreSQL 12+ (some features require 15+)

## License

MIT

---

Built by [IndieKit](https://github.com/indiekitai) 🛠️
