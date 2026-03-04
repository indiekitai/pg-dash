# Real-World Example: Running pg-dash Against a Production Database

This is a real health check run against a production PostgreSQL database. No cherry-picking — this is what pg-dash actually finds on a live app.

## The Setup

We're checking a production database for a social app with ~20 tables: users, articles, flash news, gifts, wallet/withdrawal flows, and more.

```bash
npx @indiekitai/pg-dash check postgresql://user:pass@host/db --format md
```

## The Output

This is the **exact output** from a real run:

```
## 🏥 pg-dash Health Report

**Score: 80/100 (B)**

| Category    | Score | Grade | Issues |
|-------------|-------|-------|--------|
| performance | 100   | A     | 0      |
| maintenance | 100   | A     | 0      |
| schema      | 83    | B     | 4      |
| security    | 95    | A     | 1      |

### ⚠️ Issues (5)

- [warning] Duplicate indexes on idempotency_keys
- [warning] Missing index on FK column tip_records.gift_id
- [warning] Missing index on FK column withdrawal_orders.reviewed_by
- [warning] Missing index on FK column system_settings.updated_by
- [warning] SSL is disabled
```

**Overall: Score 80/100, Grade B.**

Performance and maintenance are clean — autovacuum is healthy, no slow queries, no bloat. The issues are all in schema and security.

## Breaking Down the Issues

### 1. Duplicate indexes on `idempotency_keys`

The table has two or more indexes covering the same columns. This wastes disk space and slows down every INSERT/UPDATE/DELETE on that table because PostgreSQL must maintain all indexes.

**Fix:**
```sql
-- Find the duplicates
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'idempotency_keys'
ORDER BY indexdef;

-- Drop the redundant one (keep the one that's actually used)
DROP INDEX CONCURRENTLY idx_duplicate_name;
```

### 2. Missing FK indexes: `tip_records.gift_id`, `withdrawal_orders.reviewed_by`, `system_settings.updated_by`

Foreign key columns without indexes. When PostgreSQL enforces a FK constraint (on delete/update of the parent), it does a sequential scan of the child table to check for dependent rows. On large tables, this is a full table scan every time.

**Fix:**
```sql
CREATE INDEX CONCURRENTLY idx_tip_records_gift_id 
  ON tip_records(gift_id);

CREATE INDEX CONCURRENTLY idx_withdrawal_orders_reviewed_by 
  ON withdrawal_orders(reviewed_by);

CREATE INDEX CONCURRENTLY idx_system_settings_updated_by 
  ON system_settings(updated_by);
```

### 3. SSL is disabled

The database accepts unencrypted connections. For a production database — especially one accessible over the internet — this means credentials and query data travel in plaintext.

**Fix:** Enable SSL in `postgresql.conf`:
```
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file  = 'server.key'
```

Then in your connection strings, add `?sslmode=require`.

## What pg-dash Didn't Find (Also Important)

- **Performance: 100/100** — No missing indexes on high-traffic tables, cache hit ratio is healthy
- **Maintenance: 100/100** — Autovacuum is keeping up, no tables with excessive dead tuples, no transaction ID wraparound risk

This is a healthy production database. The 5 warnings are real issues worth fixing — they're just not on fire yet.

## Run It Yourself

```bash
# Text output (default)
npx @indiekitai/pg-dash check postgresql://user:pass@host/db

# Markdown (for PR comments, Notion, etc.)
npx @indiekitai/pg-dash check postgresql://user:pass@host/db --format md

# JSON (for scripting)
npx @indiekitai/pg-dash check postgresql://user:pass@host/db --format json

# Fail if score drops below 80
npx @indiekitai/pg-dash check postgresql://user:pass@host/db --threshold 80

# Track progress over time
npx @indiekitai/pg-dash check postgresql://user:pass@host/db --diff
```

## Full Dashboard

For deeper investigation — live query stats, schema browser, time-series charts — spin up the full dashboard:

```bash
npx @indiekitai/pg-dash postgresql://user:pass@host/db
# Opens http://localhost:3480
```
