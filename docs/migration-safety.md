# Migration Safety Guide

**Catch lock risks before they hit production.** pg-dash analyzes your migration SQL files and flags anything that could cause downtime, lock tables, or fail silently.

## The Problem

A migration that works fine on your empty dev database can bring production to its knees. The most common culprit: `CREATE INDEX` on a live table locks out all writes for the duration of the build.

With a 10-million-row table, that's minutes of downtime.

## A Real Example

Here's an actual migration file from a production app — `004_news_module_update.sql`. It adds fields and indexes to a `flash_news` and `articles` table.

### The Migration File

```sql
-- 004_news_module_update.sql
-- Adding fields to flash_news and articles tables

ALTER TABLE flash_news ADD COLUMN IF NOT EXISTS title VARCHAR(100);
ALTER TABLE flash_news ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE flash_news ADD COLUMN IF NOT EXISTS market_impact JSONB;
ALTER TABLE flash_news ADD COLUMN IF NOT EXISTS tags VARCHAR[] DEFAULT '{}';
ALTER TABLE flash_news ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE flash_news ADD COLUMN IF NOT EXISTS views_count INT DEFAULT 0;
ALTER TABLE flash_news ADD COLUMN IF NOT EXISTS updated_at BIGINT;

UPDATE flash_news SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE flash_news ALTER COLUMN updated_at SET NOT NULL;

-- ⚠️ These three lines are the problem:
CREATE INDEX IF NOT EXISTS idx_flash_category ON flash_news(category);
CREATE INDEX IF NOT EXISTS idx_flash_importance ON flash_news(importance);
CREATE INDEX IF NOT EXISTS idx_flash_pinned ON flash_news(is_pinned) WHERE is_pinned = TRUE;

ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_type VARCHAR(20) DEFAULT 'news';
UPDATE articles SET content_type = 'news' WHERE content_type IS NULL;
ALTER TABLE articles ALTER COLUMN content_type SET NOT NULL;

-- ⚠️ And these two:
CREATE INDEX IF NOT EXISTS idx_articles_content_type ON articles(content_type);
CREATE INDEX IF NOT EXISTS idx_articles_recommend ON articles(recommend_level DESC);
```

Looks fine, right? Let's see what pg-dash finds.

### Running the Check

```bash
npx @indiekitai/pg-dash check-migration ./migrations/004_news_module_update.sql
```

### Real Output

```
Migration check: 004_news_module_update.sql
────────────────────────────────────────────────
  ⚠  CREATE INDEX on existing table will lock writes. Use CREATE INDEX CONCURRENTLY to avoid downtime.
     Suggestion: Replace CREATE INDEX with CREATE INDEX CONCURRENTLY
     Line 50

  ⚠  CREATE INDEX on existing table will lock writes. Use CREATE INDEX CONCURRENTLY to avoid downtime.
     Suggestion: Replace CREATE INDEX with CREATE INDEX CONCURRENTLY
     Line 51

  ⚠  CREATE INDEX on existing table will lock writes. Use CREATE INDEX CONCURRENTLY to avoid downtime.
     Suggestion: Replace CREATE INDEX with CREATE INDEX CONCURRENTLY
     Line 52

  ⚠  CREATE INDEX on existing table will lock writes. Use CREATE INDEX CONCURRENTLY to avoid downtime.
     Suggestion: Replace CREATE INDEX with CREATE INDEX CONCURRENTLY
     Line 76

  ⚠  CREATE INDEX on existing table will lock writes. Use CREATE INDEX CONCURRENTLY to avoid downtime.
     Suggestion: Replace CREATE INDEX with CREATE INDEX CONCURRENTLY
     Line 77

────────────────────────────────────────────────
Result: SAFE — 0 errors, 5 warnings, 0 infos

Run with a connection string for more accurate row count estimates.
```

**5 warnings. All `CREATE INDEX` without `CONCURRENTLY`.**

## Why It Matters

When you run `CREATE INDEX` (without `CONCURRENTLY`), PostgreSQL acquires a **`ShareLock`** on the table. This blocks:

- All `INSERT` statements
- All `UPDATE` statements
- All `DELETE` statements

For the entire duration of the index build.

On a small dev table (1,000 rows), this takes milliseconds. On production (1,000,000 rows), this can take 30 seconds to several minutes. During that time, every write to `flash_news` or `articles` queues up and waits. If your app doesn't have aggressive connection timeouts, requests pile up and your whole service degrades.

This is one of the most common causes of "we pushed a migration and the site went down for 3 minutes."

## The Fix

Replace `CREATE INDEX` with `CREATE INDEX CONCURRENTLY`. This builds the index in the background without taking a write lock.

### Fixed Migration

```sql
-- Safe version: no write locks during index build
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flash_category 
  ON flash_news(category);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flash_importance 
  ON flash_news(importance);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flash_pinned 
  ON flash_news(is_pinned) WHERE is_pinned = TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_articles_content_type 
  ON articles(content_type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_articles_recommend 
  ON articles(recommend_level DESC);
```

### Important Caveat

`CREATE INDEX CONCURRENTLY` **cannot run inside a transaction block**. If your migration runner wraps everything in `BEGIN`/`COMMIT`, you'll get an error.

For tools like Flyway, Liquibase, or plain psql scripts — run the `CONCURRENTLY` index builds in a separate, non-transactional step.

```sql
-- ✅ Works: no wrapping transaction
CREATE INDEX CONCURRENTLY idx_flash_category ON flash_news(category);

-- ❌ Fails at runtime:
BEGIN;
CREATE INDEX CONCURRENTLY idx_flash_category ON flash_news(category);
COMMIT;
```

pg-dash also detects this pattern and flags it as an error (not just a warning).

## Connect to Your Database for Better Analysis

Without a connection string, pg-dash analyzes the SQL statically. Add your database URL to get row-count estimates — how long the lock will actually last:

```bash
npx @indiekitai/pg-dash check-migration ./migrations/004_news_module_update.sql \
  postgresql://user:pass@host/db
```

With a live connection, pg-dash can tell you:
- "This table has 2.4M rows — estimated lock time: ~45 seconds"
- Whether the referenced tables actually exist
- Whether the columns being indexed are already covered by another index

## CI Integration: Block Merges With Risky Migrations

Run this in your pipeline:

```bash
npx @indiekitai/pg-dash check-migration ./migrations/*.sql \
  $DATABASE_URL \
  --ci
```

The `--ci` flag emits GitHub Actions annotations:

```
::error file=migrations/004_news_module_update.sql,line=50::CREATE INDEX on existing table will lock writes. Use CREATE INDEX CONCURRENTLY to avoid downtime.
```

These show up as inline PR comments pointing to the exact line.

### Sample Workflow

```yaml
- name: Check migration safety
  run: |
    npx @indiekitai/pg-dash check-migration \
      $(git diff --name-only HEAD~1 | grep '\.sql$') \
      ${{ secrets.DATABASE_URL }} \
      --ci
```

## What Else pg-dash Catches

Beyond `CREATE INDEX` without `CONCURRENTLY`, the migration checker also flags:

| Pattern | Risk | Severity |
|---------|------|----------|
| `ADD COLUMN NOT NULL` without `DEFAULT` | Rewrites entire table in PG < 11 | Error |
| `ALTER COLUMN TYPE` | Full table rewrite + lock | Error |
| `DROP TABLE` / `TRUNCATE` | Irreversible data loss | Error |
| `DELETE`/`UPDATE` without `WHERE` | Wipes all rows | Error |
| `ADD CONSTRAINT` without `NOT VALID` | Full table scan, locks reads | Warning |
| `CREATE INDEX CONCURRENTLY` inside `BEGIN` | Fails at runtime | Error |
| `DROP COLUMN` | App code may break if not coordinated | Warning |

Run `check-migration` before every migration — it takes under a second and can save you from a late-night incident.
