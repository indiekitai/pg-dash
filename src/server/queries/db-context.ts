import type { Pool } from "pg";

/**
 * Business intent inference based on table/column names
 */
function inferBusinessIntent(tableName: string, columnNames: string[]): string {
  const name = tableName.toLowerCase();
  const cols = columnNames.map(c => c.toLowerCase());
  
  // Common patterns
  const patterns: [RegExp, string][] = [
    [/^(user|users?|account|accounts?|customer|customers?|member|members?)$/, "用户/会员管理"],
    [/^(order|orders?|purchase|purchases?)$/, "订单/购买记录"],
    [/^(product|products?|item|items?|goods?)$/, "商品/产品目录"],
    [/^(payment|payments?|transaction|transactions?|invoice|invoices?)$/, "支付/交易记录"],
    [/^(session|sessions?|auth|authentication|token|tokens?)$/, "认证/会话管理"],
    [/^(log|logs?|audit|audits?|history|histories?)$/, "日志/审计记录"],
    [/^(config|configuration|settings?)$/, "配置/设置"],
    [/^(category|categories?|tag|tags?|group|groups?)$/, "分类/标签/分组"],
    [/^(comment|comments?|review|reviews?|feedback)$/, "评论/反馈"],
    [/^(notification|notifications?|message|messages?)$/, "通知/消息"],
    [/^(file|files?|attachment|attachments?|media)$/, "文件/媒体"],
    [/^(api[_-]?key|api[_-]?key|key|keys?|credential|credentials?)$/, "API 密钥/凭证"],
    [/^(job|jobs?|queue|queues?|task|tasks?)$/, "任务/队列"],
    [/^(subscription|subscriptions?|plan|plans?)$/, "订阅/套餐"],
    [/^(coupon|coupons?|promo|promotion|promotions?)$/, "优惠/促销"],
    [/^(analytics?|statistic|statistics?|metric|metrics?)$/, "分析/统计"],
  ];

  for (const [pattern, intent] of patterns) {
    if (pattern.test(name)) return intent;
  }

  // Check columns for hints
  const colPatterns: [RegExp, string][] = [
    [/user_id|customer_id|member_id/, "用户关联"],
    [/order_id|purchase_id/, "订单关联"],
    [/product_id|item_id/, "商品关联"],
    [/status|state/, "状态管理"],
    [/created_at|updated_at|deleted_at/, "时间戳/软删除"],
    [/email|phone|address/, "联系信息"],
    [/price|amount|total|cost/, "金额/价格"],
    [/quantity|count|qty/, "数量"],
    [/latitude|longitude|location/, "地理位置"],
    [/ip|user_agent|browser/, "访问信息"],
  ];

  const matchedColHints = colPatterns.filter(([pattern]) => 
    cols.some(col => pattern.test(col))
  ).map(([, hint]) => hint);

  if (matchedColHints.length > 0) {
    return `数据表 (可能用途: ${matchedColHints.slice(0, 2).join("、")})`;
  }

  return "通用数据表";
}

/**
 * Get comprehensive database context for AI agents
 */
export async function getDbContext(pool: Pool) {
  const client = await pool.connect();

  try {
    // 1. Get all tables with basic info
    const tablesResult = await client.query(`
      SELECT
        n.nspname AS schema,
        c.relname AS table_name,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
        pg_total_relation_size(c.oid) AS total_size_bytes,
        pg_relation_size(c.oid) AS table_size_bytes,
        pg_indexes_size(c.oid) AS index_size_bytes,
        s.n_live_tup AS row_count,
        s.n_dead_tup AS dead_tuples,
        obj_description(c.oid) AS description
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY pg_total_relation_size(c.oid) DESC
    `);

    // 2. Get columns for all tables
    const columnsResult = await client.query(`
      SELECT
        n.nspname AS schema,
        c.relname AS table_name,
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        NOT a.attnotnull AS is_nullable,
        pg_get_expr(d.adbin, d.adrelid) AS default_value,
        col_description(a.attrelid, a.attnum) AS description,
        a.attnum AS ordinal_position
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE a.attnum > 0 AND NOT a.attisdropped
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, c.relname, a.attnum
    `);

    // 3. Get primary keys
    const pkResult = await client.query(`
      SELECT
        n.nspname AS schema,
        c.relname AS table_name,
        a.attname AS column_name
      FROM pg_index idx
      JOIN pg_class c ON idx.indrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(idx.indkey)
      WHERE idx.indisprimary = true
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, c.relname, a.attnum
    `);

    // 4. Get foreign keys
    const fkResult = await client.query(`
      SELECT
        n.nspname AS schema,
        c.relname AS table_name,
        a.attname AS column_name,
        ref_n.nspname AS referenced_schema,
        ref_c.relname AS referenced_table,
        ref_a.attname AS referenced_column,
        conname AS constraint_name
      FROM pg_constraint con
      JOIN pg_class c ON con.conrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
      JOIN pg_class ref_c ON con.confrelid = ref_c.oid
      JOIN pg_namespace ref_n ON ref_c.relnamespace = ref_n.oid
      JOIN pg_attribute ref_a ON ref_a.attrelid = ref_c.oid AND ref_a.attnum = ANY(con.confkey)
      WHERE con.contype = 'f'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, c.relname, con.conname
    `);

    // 5. Get indexes
    const indexesResult = await client.query(`
      SELECT
        n.nspname AS schema,
        t.relname AS table_name,
        i.relname AS index_name,
        am.amname AS index_type,
        pg_get_indexdef(idx.indexrelid) AS definition,
        idx.indisunique AS is_unique,
        idx.indisprimary AS is_primary,
        pg_relation_size(i.oid) AS size_bytes
      FROM pg_index idx
      JOIN pg_class i ON idx.indexrelid = i.oid
      JOIN pg_class t ON idx.indrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      JOIN pg_am am ON i.relam = am.oid
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY t.relname, i.relname
    `);

    // Organize data
    const tables = tablesResult.rows;
    const allColumns = columnsResult.rows;
    const primaryKeys = pkResult.rows;
    const foreignKeys = fkResult.rows;
    const indexes = indexesResult.rows;

    // Group columns by table
    const columnsByTable = new Map<string, typeof allColumns>();
    for (const col of allColumns) {
      const key = `${col.schema}.${col.table_name}`;
      if (!columnsByTable.has(key)) columnsByTable.set(key, []);
      columnsByTable.get(key)!.push(col);
    }

    // Group primary keys by table
    const pkByTable = new Map<string, string[]>();
    for (const pk of primaryKeys) {
      const key = `${pk.schema}.${pk.table_name}`;
      if (!pkByTable.has(key)) pkByTable.set(key, []);
      pkByTable.get(key)!.push(pk.column_name);
    }

    // Group foreign keys by table
    const fkByTable = new Map<string, typeof foreignKeys>();
    for (const fk of foreignKeys) {
      const key = `${fk.schema}.${fk.table_name}`;
      if (!fkByTable.has(key)) fkByTable.set(key, []);
      const fks = fkByTable.get(key)!;
      // Avoid duplicates
      if (!fks.some(existing => existing.constraint_name === fk.constraint_name)) {
        fks.push(fk);
      }
    }

    // Group indexes by table
    const indexesByTable = new Map<string, typeof indexes>();
    for (const idx of indexes) {
      const key = `${idx.schema}.${idx.table_name}`;
      if (!indexesByTable.has(key)) indexesByTable.set(key, []);
      indexesByTable.get(key)!.push(idx);
    }

    // Build structured response
    const tableSummaries = tables.map(table => {
      const key = `${table.schema}.${table.table_name}`;
      const columns = columnsByTable.get(key) || [];
      const pks = pkByTable.get(key) || [];
      const fks = fkByTable.get(key) || [];
      const tableIndexes = indexesByTable.get(key) || [];

      return {
        schema: table.schema,
        name: table.table_name,
        description: table.description,
        rowCount: table.row_count || 0,
        totalSize: table.total_size,
        tableSizeBytes: parseInt(table.table_size_bytes) || 0,
        indexSizeBytes: parseInt(table.index_size_bytes) || 0,
        deadTuples: table.dead_tuples || 0,
        businessIntent: inferBusinessIntent(
          table.table_name,
          columns.map(c => c.column_name)
        ),
        columns: columns.map(col => ({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable,
          defaultValue: col.default_value,
          description: col.description,
          isPrimaryKey: pks.includes(col.column_name),
          isForeignKey: fks.some(fk => fk.column_name === col.column_name),
          referencedTable: fks.find(fk => fk.column_name === col.column_name)?.referenced_table,
          referencedColumn: fks.find(fk => fk.column_name === col.column_name)?.referenced_column,
        })),
        primaryKeys: pks,
        foreignKeys: fks.map(fk => ({
          column: fk.column_name,
          references: `${fk.referenced_schema}.${fk.referenced_table}.${fk.referenced_column}`,
        })),
        indexes: tableIndexes.map(idx => ({
          name: idx.index_name,
          type: idx.index_type,
          definition: idx.definition,
          isUnique: idx.is_unique,
          isPrimary: idx.is_primary,
          sizeBytes: parseInt(idx.size_bytes) || 0,
        })),
      };
    });

    // Build index summary
    const indexSummary = tables.map(table => {
      const key = `${table.schema}.${table.table_name}`;
      const tableIndexes = indexesByTable.get(key) || [];
      return {
        table: `${table.schema}.${table.table_name}`,
        hasIndexes: tableIndexes.length > 0,
        indexCount: tableIndexes.length,
        indexTypes: [...new Set(tableIndexes.map(i => i.index_type))],
        primaryIndex: tableIndexes.some(i => i.is_primary),
        uniqueIndexes: tableIndexes.filter(i => i.is_unique).length,
      };
    });

    return {
      database: {
        schema: tables[0]?.schema || "public",
        tableCount: tables.length,
        totalSize: tables.reduce((sum, t) => sum + (parseInt(t.total_size_bytes) || 0), 0),
        totalRows: tables.reduce((sum, t) => sum + (t.row_count || 0), 0),
      },
      tables: tableSummaries,
      indexSummary,
    };
  } finally {
    client.release();
  }
}
