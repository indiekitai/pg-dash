# Changelog

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
