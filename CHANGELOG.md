# Changelog

## [0.10.0] - 2026-04-23
### Added
- **Prepared-statement cache invalidation warning** in `check-migration`: DDL that alters column layout (`ALTER TABLE ... ADD|DROP|ALTER|RENAME COLUMN`) or drops a table now emits a warning explaining that long-running application workers using asyncpg / node-postgres / JDBC / psycopg2 prepared-statement caches must be restarted after the migration runs. Suggestion includes the `statement_cache_size=0` opt-out for asyncpg. Inspired by a real incident in a production codebase.

### Changed
- README now leads with three "daily drivers" (`check-migration`, `check`, `bloat`) instead of the total tool count, to make the 80/20 use case obvious.

## [0.9.1] - 2026-03-20
### Fixed
- Unused indexes query correctly counts indexes across all schemas.

## [0.9.0] - 2026-03-20
### Added
- **Table/index bloat analysis**: New `pg-dash bloat` command
  - Detect bloated tables by dead tuple percentage
  - Find unused indexes (idx_scan = 0)
  - Identify tables that never get vacuumed
  - No extension required (uses pg_stat_user_tables)

## [0.8.0] - 2026-03-20
### Added
- **Slow query analysis**: New `pg-dash slow-queries` command to analyze slow queries from pg_stat_statements
  - Sort by: total time, mean time, or call frequency
  - Filter by minimum call count
  - Show cache hit ratio, temp blocks, execution stats
  - JSON output for automation

### Changed
- Improved CLI help text

## [0.7.1] - 2026-03-11
### Added
- **Batch safe operations**: `pg_dash_fix` now supports multiple statements separated by semicolons (e.g., `VACUUM table1; VACUUM table2; ANALYZE table3`)
- **ALTER TABLE SET support**: Allowed storage parameter changes (e.g., `ALTER TABLE t SET (autovacuum_vacuum_threshold = 5)`)
- **pg_stat_statements detection**: Advisor now warns when the extension is not installed (critical for slow query visibility)
- **Small table autovacuum**: New check for tables with <50 rows that never get autovacuumed due to default threshold

### Fixed
- **Dead tuple calculation**: Fixed percentage calculation to use total rows (live + dead) instead of just live rows
- **Unused index threshold**: Reduced from 1MB to 8KB to catch smaller unused indexes
- **pg_dash_explain**: Fixed parameter name from `query` to `sql`

## [0.7.0] - 2026-03-11
### Added
- **AI-Powered Database Context**:
  - `fetch_db_context` MCP tool — Get comprehensive database context (schema, tables, columns, indexes, PK/FK, business intent, and health) in a single call. Designed for AI agents to quickly understand the whole DB.
  - `pg_dash_query_natural` MCP tool — Query database using natural language. LLM converts your question to SQL (supports OpenAI, Anthropic, Google, Ollama). Examples: "show me slow queries last hour", "find missing indexes", "what's the health score", "list all tables with their sizes"
- **AI-Powered CI Enhancements**:
  - `pg-dash check --ai-suggest`: Generates AI-powered fix suggestions for health issues (Markdown compatible).
  - `pg-dash diff-env --ai-explain`: Uses LLM to explain the business impact of schema differences.
  - `ci_health_summary` MCP tool: Returns a one-sentence summary and prioritized issue list for CI systems.
- Configure LLM via environment variables: `PG_DASH_LLM_PROVIDER`, `PG_DASH_LLM_API_KEY`, `PG_DASH_LLM_MODEL`, `PG_DASH_LLM_BASE_URL`

## [0.5.1] - 2026-03-05
### Changed
- Updated README (EN + ZH) to document `explain` and `watch-locks` commands with examples

## [0.5.0] - 2026-03-05
### Added
- `pg-dash explain "<query>" <connection>` — EXPLAIN ANALYZE in the terminal, color-coded tree with recommendations
- `pg-dash watch-locks <connection>` — real-time lock wait + long-query monitor (refreshes every 3s, Ctrl+C to exit)
- `--no-analyze` flag for `explain` (EXPLAIN only, no actual execution)

## [0.4.6] - 2026-02-28
### Fixed
- schema-diff: better handling of edge cases in column diff detection

## [0.4.5] - 2026-02-25
### Added
- `diff-env --health` flag: include health score comparison between environments
- Enum type differences now detected in `diff-env`
- Foreign key and CHECK constraint diffs in `diff-env`

## [0.4.4] - 2026-02-20
### Added
- Disk space monitoring with per-table size breakdown
- Growth prediction using linear regression ("days until disk full")

## [0.4.3] - 2026-02-15
### Added
- Slack & Discord webhook notifications for alerts
- 7 default alert rules (connection utilization, cache ratio, long queries, etc.)

## [0.4.2] - 2026-02-10
### Added
- `schema-diff` command: show latest schema changes from tracking history
- Schema change tracking: automatic snapshots every 6 hours

## [0.4.1] - 2026-02-05
### Added
- `diff-env` command: compare schema and health between two PostgreSQL environments
- `pg_dash_compare_env` MCP tool

## [0.4.0] - 2026-02-01
### Added
- MCP server with 23 tools for AI-assisted PostgreSQL optimization
- `check-migration` command: static + dynamic analysis of SQL migration files
- Query intelligence: regression detection, EXPLAIN ANALYZE suggestions
- `--ci` flag for GitHub Actions annotations
- `--diff` flag for tracking changes between runs
