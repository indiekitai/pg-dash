# CI Integration Guide

Catch database regressions automatically — before they reach production. pg-dash integrates with GitHub Actions via `--ci` and `--diff` flags.

## The Flags

| Flag | What It Does |
|------|-------------|
| `--ci` | Emits `::error::` / `::warning::` GitHub Actions annotations (inline PR comments) |
| `--diff` | Compares current health with the last saved snapshot — shows what got better or worse |
| `--snapshot-path` | Where to save/load the snapshot file |
| `--format md` | Outputs Markdown (for PR comments) instead of terminal text |
| `--threshold N` | Exits with code 1 if health score < N (default: 70) |

## Full Workflow

The complete workflow is in [`examples/github-actions-pg-check.yml`](../examples/github-actions-pg-check.yml). Here's a walkthrough of what it does:

```yaml
name: Database Health Check
on:
  push:
    paths: ['migrations/**', 'prisma/**', 'drizzle/**', 'supabase/migrations/**']
  pull_request:
    paths: ['migrations/**', 'prisma/**', 'drizzle/**', 'supabase/migrations/**']
  schedule:
    - cron: '0 8 * * 1'  # Weekly Monday 8am UTC
```

**Triggers:** Runs when migration files change (on push or PR), and weekly on Mondays. You don't need to run this on every commit — only when the database might have changed.

```yaml
      - name: Restore health snapshot
        uses: actions/cache@v4
        with:
          path: .pg-dash-cache
          key: pg-dash-snapshot-${{ github.ref }}
          restore-keys: |
            pg-dash-snapshot-
```

**Snapshot cache:** The `--diff` flag needs a previous snapshot to compare against. GitHub Actions runners are ephemeral (each run starts fresh), so we cache the snapshot file across runs. `restore-keys` falls back to any branch's snapshot if the exact key isn't found.

```yaml
      - name: Run pg-dash health check
        id: pg-check
        run: |
          mkdir -p .pg-dash-cache
          npx @indiekitai/pg-dash check ${{ secrets.DATABASE_URL }} \
            --ci \
            --diff \
            --snapshot-path ./.pg-dash-cache/last-check.json \
            --format md > pg-dash-report.md
          echo "exit_code=$?" >> $GITHUB_OUTPUT
        continue-on-error: true
```

**The check:** Runs against `$DATABASE_URL` (stored as a GitHub secret). `continue-on-error: true` lets the workflow continue so it can post the PR comment even if the health check fails.

```yaml
      - name: Comment PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = fs.readFileSync('pg-dash-report.md', 'utf8');
            // ... finds existing comment and updates it, or creates a new one
```

**PR comments:** On pull requests, posts the Markdown report as a comment. If a comment already exists (from a previous push to the same PR), it updates it instead of creating a new one. No comment spam.

## What `--diff` Shows

Without `--diff`, you get the current state. With `--diff`, you see what changed:

### Before (baseline, 3 issues)
```
Score: 80/100 (B)
Issues:
- [warning] Duplicate indexes on idempotency_keys
- [warning] Missing index on FK column tip_records.gift_id
- [warning] SSL is disabled
```

### After running the migration (2 issues fixed)
```
Score: 92/100 (A)

📈 Changes since last check:
  ✅ Fixed: Missing index on FK column tip_records.gift_id
  ✅ Fixed: Duplicate indexes on idempotency_keys
  ⚠️ Still open: SSL is disabled

Issues:
- [warning] SSL is disabled
```

The diff makes it immediately obvious whether a PR improved or degraded database health. Perfect for migration PRs.

## What a Failing Check Looks Like

When `--ci` is active and pg-dash finds issues, it emits GitHub Actions annotations. These appear as **inline comments on the relevant files** in the PR review interface.

For a health check:
```
::warning ::Missing index on FK column tip_records.gift_id
::warning ::SSL is disabled
::error ::Health score 58/100 is below threshold 70
```

For a migration check with `--ci`:
```
::warning file=migrations/004_news_module_update.sql,line=50::CREATE INDEX on existing table will lock writes. Use CREATE INDEX CONCURRENTLY to avoid downtime.
::warning file=migrations/004_news_module_update.sql,line=51::CREATE INDEX on existing table will lock writes. Use CREATE INDEX CONCURRENTLY to avoid downtime.
```

The migration annotations point to the **exact line** in the SQL file. Reviewers can see the problem without reading the full output.

The job exits with code 1 (failing the CI step) when:
- Health score is below `--threshold` (default: 70)
- A migration has `error`-level issues (not just warnings)

## What a Passing Check Looks Like

```
Score: 92/100 (A)

📈 Changes since last check:
  ✅ Fixed: Missing index on FK column tip_records.gift_id

Issues (1):
- [warning] SSL is disabled

Result: PASSED (score 92 ≥ threshold 70)
```

Exit code 0. The "Fail if unhealthy" step is skipped. PR gets a green check.

## Setting Up

### 1. Add the DATABASE_URL secret

In your GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**

- Name: `DATABASE_URL`
- Value: `postgresql://user:pass@host/db`

Use a **read-only** database user for CI. pg-dash health checks only need `SELECT` on system views. Create one:

```sql
CREATE USER pg_dash_ci WITH PASSWORD 'your-password';
GRANT pg_monitor TO pg_dash_ci;
GRANT CONNECT ON DATABASE your_db TO pg_dash_ci;
```

### 2. Copy the workflow file

```bash
mkdir -p .github/workflows
cp examples/github-actions-pg-check.yml .github/workflows/pg-check.yml
```

### 3. Push and open a PR

The workflow runs automatically. Check the **Actions** tab to see the output, and look for the pg-dash comment on your PR.

## Migration-Only Checks

If you only want to catch risky migrations (not full health checks), use `check-migration` instead:

```yaml
- name: Check migration safety
  run: |
    # Get changed SQL files
    CHANGED=$(git diff --name-only HEAD~1 | grep '\.sql$' || echo "")
    if [ -n "$CHANGED" ]; then
      npx @indiekitai/pg-dash check-migration $CHANGED \
        ${{ secrets.DATABASE_URL }} \
        --ci
    fi
```

This is faster (no DB health scan) and gives inline annotations on the SQL files themselves.

## Tips

**Use a staging database, not production.** Connect to a staging environment that mirrors production. You want real schema and realistic data sizes, but not actual production traffic.

**Set a realistic threshold.** A brand-new database with no traffic will score near 100. A real production database with years of organic schema growth might hover around 80. Set `--threshold` to match your baseline.

**The cache key matters.** Using `${{ github.ref }}` as the cache key means each branch tracks its own snapshot independently. The `restore-keys` fallback means a new branch starts from the closest ancestor's snapshot, not from scratch.

**Weekly runs catch drift.** Even without migration changes, a weekly health check catches things like autovacuum falling behind, unused index accumulation, or bloat growing on high-churn tables.
