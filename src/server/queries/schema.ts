import type { Pool } from "pg";

export async function getSchemaTables(pool: Pool) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT
        c.relname AS name,
        n.nspname AS schema,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
        pg_total_relation_size(c.oid) AS total_size_bytes,
        pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
        pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS index_size,
        s.n_live_tup AS row_count,
        obj_description(c.oid) AS description
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY pg_total_relation_size(c.oid) DESC
    `);
    return r.rows;
  } finally {
    client.release();
  }
}

export async function getSchemaTableDetail(pool: Pool, tableName: string) {
  const client = await pool.connect();
  try {
    // Parse schema.table or default to public
    const parts = tableName.split(".");
    const schema = parts.length > 1 ? parts[0] : "public";
    const name = parts.length > 1 ? parts[1] : parts[0];

    // Table info
    const tableInfo = await client.query(`
      SELECT
        c.relname AS name, n.nspname AS schema,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
        pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
        pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS index_size,
        pg_size_pretty(pg_relation_size(c.reltoastrelid)) AS toast_size,
        s.n_live_tup AS row_count, s.n_dead_tup AS dead_tuples,
        s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze,
        s.seq_scan, s.idx_scan
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relname = $1 AND n.nspname = $2 AND c.relkind = 'r'
    `, [name, schema]);

    if (tableInfo.rows.length === 0) return null;

    // Columns
    const columns = await client.query(`
      SELECT
        a.attname AS name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
        NOT a.attnotnull AS nullable,
        pg_get_expr(d.adbin, d.adrelid) AS default_value,
        col_description(a.attrelid, a.attnum) AS description
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE a.attrelid = (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE c.relname = $1 AND n.nspname = $2)
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `, [name, schema]);

    // Indexes
    const indexes = await client.query(`
      SELECT
        i.relname AS name,
        am.amname AS type,
        pg_size_pretty(pg_relation_size(i.oid)) AS size,
        pg_get_indexdef(idx.indexrelid) AS definition,
        idx.indisunique AS is_unique,
        idx.indisprimary AS is_primary,
        s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
      FROM pg_index idx
      JOIN pg_class i ON idx.indexrelid = i.oid
      JOIN pg_class t ON idx.indrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      JOIN pg_am am ON i.relam = am.oid
      LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.oid
      WHERE t.relname = $1 AND n.nspname = $2
      ORDER BY i.relname
    `, [name, schema]);

    // Constraints
    const constraints = await client.query(`
      SELECT
        conname AS name,
        CASE contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'f' THEN 'FOREIGN KEY'
          WHEN 'u' THEN 'UNIQUE' WHEN 'c' THEN 'CHECK' WHEN 'x' THEN 'EXCLUDE' END AS type,
        pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid WHERE c.relname = $1 AND n.nspname = $2)
      ORDER BY
        CASE contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'f' THEN 3 WHEN 'c' THEN 4 ELSE 5 END
    `, [name, schema]);

    // Foreign keys (outgoing)
    const foreignKeys = await client.query(`
      SELECT
        conname AS name,
        a.attname AS column_name,
        confrelid::regclass::text AS referenced_table,
        af.attname AS referenced_column
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = ANY(c.confkey)
      WHERE c.contype = 'f'
        AND c.conrelid = (SELECT cl.oid FROM pg_class cl JOIN pg_namespace n ON cl.relnamespace = n.oid WHERE cl.relname = $1 AND n.nspname = $2)
    `, [name, schema]);

    // Sample data (first 10 rows)
    let sampleData: any[] = [];
    try {
      const sample = await client.query(
        `SELECT * FROM ${client.escapeIdentifier(schema)}.${client.escapeIdentifier(name)} LIMIT 10`
      );
      sampleData = sample.rows;
    } catch {}

    return {
      ...tableInfo.rows[0],
      columns: columns.rows,
      indexes: indexes.rows,
      constraints: constraints.rows,
      foreignKeys: foreignKeys.rows,
      sampleData,
    };
  } finally {
    client.release();
  }
}

export async function getSchemaIndexes(pool: Pool) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT
        n.nspname AS schema,
        t.relname AS table_name,
        i.relname AS name,
        am.amname AS type,
        pg_size_pretty(pg_relation_size(i.oid)) AS size,
        pg_relation_size(i.oid) AS size_bytes,
        pg_get_indexdef(idx.indexrelid) AS definition,
        idx.indisunique AS is_unique,
        idx.indisprimary AS is_primary,
        s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
      FROM pg_index idx
      JOIN pg_class i ON idx.indexrelid = i.oid
      JOIN pg_class t ON idx.indrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      JOIN pg_am am ON i.relam = am.oid
      LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.oid
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY pg_relation_size(i.oid) DESC
    `);
    return r.rows;
  } finally {
    client.release();
  }
}

export async function getSchemaFunctions(pool: Pool) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT
        n.nspname AS schema,
        p.proname AS name,
        pg_get_function_result(p.oid) AS return_type,
        pg_get_function_arguments(p.oid) AS arguments,
        l.lanname AS language,
        p.prosrc AS source,
        CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' END AS kind
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_language l ON p.prolang = l.oid
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, p.proname
    `);
    return r.rows;
  } finally {
    client.release();
  }
}

export async function getSchemaExtensions(pool: Pool) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT extname AS name, extversion AS installed_version,
        n.nspname AS schema, obj_description(e.oid) AS description
      FROM pg_extension e
      JOIN pg_namespace n ON e.extnamespace = n.oid
      ORDER BY extname
    `);
    return r.rows;
  } finally {
    client.release();
  }
}

export async function getSchemaEnums(pool: Pool) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT
        t.typname AS name,
        n.nspname AS schema,
        array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      GROUP BY t.typname, n.nspname
      ORDER BY t.typname
    `);
    return r.rows;
  } finally {
    client.release();
  }
}
