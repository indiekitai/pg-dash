[English](README.md) | [中文](README.zh-CN.md)

# pg-dash

**Lightweight PostgreSQL monitoring dashboard.** One command to start, built-in web UI, actionable fix suggestions.

Think **pganalyze for indie devs** — no Grafana, no Prometheus, no Docker. Just `npx` and go.

```bash
npx @indiekitai/pg-dash postgres://user:pass@host/db
```

## Why?

| Tool | Price | Setup | For |
|------|-------|-------|-----|
| pganalyze | $149+/mo | SaaS signup | Enterprises |
| Grafana+Prometheus | Free | 3 services to configure | DevOps teams |
| pgAdmin | Free | Complex UI | DBAs |
| **pg-dash** | **Free** | **One command** | **Developers** |

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

### 🤖 MCP Server
- 8 tools for AI agent integration
- `pg-dash-mcp postgres://...` — works with Claude, Cursor, etc.

### 🖥️ CLI
```bash
# Start dashboard
pg-dash postgres://user:pass@host/db

# Health check (great for CI/CD)
pg-dash check postgres://user:pass@host/db
pg-dash check postgres://... --format json --threshold 70

# Schema changes
pg-dash schema-diff postgres://user:pass@host/db

# JSON dump
pg-dash postgres://... --json
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
pg-dash <connection-string>          Start dashboard
pg-dash check <connection-string>    Run health check and exit
pg-dash schema-diff <connection-string>  Show schema changes

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
  -f, --format <fmt>     Output format: text|json (default: text)
  --query-stats-interval <min>  Query stats snapshot interval in minutes (default: 5)
  --slack-webhook <url>  Slack webhook URL for alert notifications
  --discord-webhook <url>  Discord webhook URL for alert notifications
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

### Available Tools (14)

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
    paths: ['migrations/**', 'prisma/**', 'drizzle/**']
  schedule:
    - cron: '0 8 * * 1'  # Weekly Monday 8am
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx @indiekitai/pg-dash check ${{ secrets.DATABASE_URL }} --ci --diff --format md
```

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
