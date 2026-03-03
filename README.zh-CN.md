[English](README.md) | [中文](README.zh-CN.md)

# pg-dash

**AI 原生的 PostgreSQL 健康检查工具。** 一条命令审计数据库，23 个 MCP 工具让 AI 帮你优化，CI 集成自动检查。

不是又一个监控面板 —— pg-dash 是为 **AI 编程工作流** 设计的：

```
开发者写了一个 migration → pg-dash check-migration（执行前检查）→
CI 跑 pg-dash check → 发现缺失索引 →
MCP 工具建议修复 → PR comment
```

```bash
# 一次性健康检查
npx @indiekitai/pg-dash check postgres://user:pass@host/db

# 执行 migration 前检查风险
npx @indiekitai/pg-dash check-migration ./migrations/015_add_index.sql

# 对比两个环境（本地 vs 预发）
npx @indiekitai/pg-dash diff-env --source postgres://localhost/db --target postgres://staging/db

# AI 助手（Claude/Cursor）通过 MCP 调用
pg-dash-mcp postgres://user:pass@host/db

# CI 流水线 + 差异对比
npx @indiekitai/pg-dash check $DATABASE_URL --ci --diff --format md
```

## 设计理念

**开发者工具就是用完即走的。** 你不会整天盯着 PostgreSQL 监控面板。你跑一次检查，修掉问题，然后继续干活。pg-dash 就是为此设计的：

- **健康检查** → 发现问题，拿到可执行的 SQL 修复建议，搞定
- **MCP 工具** → 让 AI 助手直接查询和修复你的数据库（独一份 —— pganalyze/pgwatch 都没有）
- **CI 集成** → 每次 migration 自动检查，不要等到生产环境出事
- **智能 diff** → 看到上次以来的变化，追踪改进进度

Dashboard 需要时可以用。但真正的核心能力在 CLI、MCP 和 CI。

## 为什么选 pg-dash？

| 工具 | 价格 | 部署 | AI 原生 | CI 就绪 |
|------|------|------|---------|---------|
| pganalyze | $149+/月 | SaaS 注册 | ❌ | ❌ |
| Grafana+Prometheus | 免费 | 配置 3 个服务 | ❌ | ❌ |
| pgAdmin | 免费 | 界面复杂 | ❌ | ❌ |
| **pg-dash** | **免费** | **一条命令** | **23 个 MCP 工具** | **`--ci --diff`** |

## 功能

### 📊 实时监控
- 实时连接数、TPS、缓存命中率、数据库大小
- 带范围选择器的时序图（5分钟 → 7天）
- WebSocket 自动刷新
- 活跃查询列表，支持取消操作

### 🏥 健康顾问
- **46+ 项自动化检查**，覆盖性能、维护、Schema、安全等维度
- A-F 健康评级，按类别分项展示
- **一键修复** —— 不只告诉你哪里有问题，还能直接修复
- SQL 白名单（仅允许安全操作：VACUUM、ANALYZE、REINDEX 等）

### 📋 Schema 浏览器
- 浏览所有表、列、索引、约束、外键
- 数据预览
- 索引使用统计
- Extension 和 Enum 类型列表

### 🔄 Schema 变更追踪
- 自动 Schema 快照（每 6 小时）
- 检测：新增/删除表、列变更、索引修改
- 时间线视图，支持 diff 对比
- 越用越有价值的粘性功能

### 🔔 告警
- 7 条默认告警规则（连接使用率、缓存比率、长查询等）
- 通过 API 自定义规则
- 冷却机制（避免告警轰炸）
- Webhook 通知
- 告警历史

### 🔍 EXPLAIN 执行计划可视化
- 在 Queries 标签页点击任意查询查看执行计划
- 树形展示 EXPLAIN 输出，便于分析

### 📈 查询趋势分析
- Trends 标签页展示 pg_stat_statements 历史快照
- 追踪查询性能随时间的变化

### 💾 磁盘空间监控
- Disk 标签页展示每张表的大小分布
- 基于线性回归的增长预测
- "距磁盘满还有多少天" 估算

### 📣 Slack 和 Discord 通知
- 告警 Webhook 通知
- 自动识别 Slack / Discord webhook URL
- 通过 `--slack-webhook` 或 `--discord-webhook` 配置

### 🛡️ Migration 安全检查
- 执行迁移前分析 SQL 文件的风险
- 检测：`CREATE INDEX`（无 `CONCURRENTLY` 会锁表）、`ADD COLUMN NOT NULL`（无 DEFAULT 会失败）、`ALTER COLUMN TYPE`（全表重写）、`DROP COLUMN`（可能 break 代码）、`ADD CONSTRAINT` 无 `NOT VALID`（全表扫描验证）、`CREATE INDEX CONCURRENTLY` 在事务内（运行时必然失败）、`DROP TABLE`、`TRUNCATE`、无 WHERE 的 `DELETE`/`UPDATE`
- 动态检查：连接数据库验证被引用表是否存在，根据实际行数估算锁表时间
- CI 友好：`--ci` 输出 `::error::` / `::warning::` GitHub Actions 注解

### 🧠 查询智能诊断
- `pg_dash_analyze_query` —— 运行 `EXPLAIN ANALYZE`，检测大表的 Seq Scan，自动生成带 benefit 评级的 `CREATE INDEX CONCURRENTLY` 建议
- `pg_dash_query_regressions` —— 找出比历史基线慢超过 50% 的查询（需要 `pg_stat_statements`）
- 面板 EXPLAIN 弹窗内联展示索引建议

### 🔄 多环境对比
- 对比两个 PostgreSQL 环境的 Schema 和健康状态（本地 vs 预发、预发 vs 生产）
- 检测：缺失/多余的表、缺失/多余的列、列类型不匹配、缺失/多余的索引、**外键和 CHECK 约束差异**、**枚举类型差异**
- `--health` 参数额外对比健康分和各环境独有的问题
- `pg_dash_compare_env` MCP 工具：直接问 AI "本地和预发有什么差异？"

### 🔧 生产就绪审计
- **废弃索引检测** — 找出从未被使用（0 次扫描）的索引，自动生成带引号的 `DROP INDEX CONCURRENTLY` SQL
- **表膨胀检测** — 统计每张表的 dead tuple 比例（≥10% 才展示），同时显示 `last_autovacuum` 和 `last_vacuum` 时间戳
- **Autovacuum 健康** — 将每张表分类为 `ok` / `stale` / `overdue` / `never`，展示带单位的 autovacuum 配置
- **锁监控** — 活跃的锁等待链（谁在阻塞谁）+ 超过 5 秒的长查询
- **配置建议** — 审计 `shared_buffers`、`work_mem`、`checkpoint_completion_target`、`random_page_cost`、`idle_in_transaction_session_timeout` 等 10 项配置，给出带严重级别的调优建议

### 🤖 MCP Server
- 23 个工具，支持 AI Agent 集成
- `pg-dash-mcp postgres://...` —— 可配合 Claude、Cursor 等使用

### 🖥️ CLI
```bash
# 启动面板
pg-dash postgres://user:pass@host/db

# 健康检查（适合 CI/CD）
pg-dash check postgres://user:pass@host/db
pg-dash check postgres://... --format json --threshold 70

# Migration 安全检查
pg-dash check-migration ./migrations/015_add_index.sql
pg-dash check-migration ./migrations/015_add_index.sql postgres://... --ci

# 多环境 Schema 对比
pg-dash diff-env --source postgres://localhost/db --target postgres://staging/db
pg-dash diff-env --source postgres://... --target postgres://... --health --format md

# Schema 变更
pg-dash schema-diff postgres://user:pass@host/db
```

## 快速开始

```bash
# 使用 npx（无需安装）
npx @indiekitai/pg-dash postgres://user:pass@localhost/mydb

# 或全局安装
npm install -g @indiekitai/pg-dash
pg-dash postgres://user:pass@localhost/mydb

# 使用独立参数
pg-dash --host localhost --user postgres --db mydb --port 3480
```

浏览器将自动打开 `http://localhost:3480`，展示完整的监控面板。

## CLI 参数

```
pg-dash <connection-string>                      启动面板
pg-dash check <connection-string>                运行健康检查并退出
pg-dash check-migration <file> [conn]            检查 migration SQL 的风险
pg-dash diff-env --source <url> --target <url>   对比两个环境
pg-dash schema-diff <connection-string>          显示 Schema 变更

Options:
  -p, --port <port>      面板端口（默认：3480）
  --no-open              不自动打开浏览器
  --json                 以 JSON 格式输出健康检查结果并退出
  --host <host>          PostgreSQL 主机
  -u, --user <user>      PostgreSQL 用户
  --password <pass>      PostgreSQL 密码
  -d, --db <database>    PostgreSQL 数据库
  --pg-port <port>       PostgreSQL 端口（默认：5432）
  --data-dir <dir>       数据目录（默认：~/.pg-dash）
  -i, --interval <sec>   采集间隔（默认：30）
  --threshold <score>    check 命令的分数阈值（默认：70）
  -f, --format <fmt>     输出格式：text|json|md（默认：text）
  --query-stats-interval <min>  查询统计快照间隔，单位分钟（默认：5）
  --slack-webhook <url>  Slack webhook URL，用于告警通知
  --discord-webhook <url>  Discord webhook URL，用于告警通知
  --ci                   输出 GitHub Actions 注解（check、check-migration、diff-env）
  --diff                 与上次快照对比（check 命令）
  --snapshot-path <path> --diff 使用的快照文件路径
  --health               包含健康对比（diff-env）
  -v, --version          显示版本
```

## MCP Server

用于 AI Agent 集成：

```bash
# 启动 MCP server
pg-dash-mcp postgres://user:pass@host/db

# 或通过环境变量
PG_DASH_CONNECTION_STRING=postgres://... pg-dash-mcp
```

### 可用工具（23 个）

| 工具 | 描述 |
|------|------|
| `pg_dash_overview` | 数据库概览（版本、运行时间、大小、连接数） |
| `pg_dash_health` | 健康报告（评分、等级、问题列表） |
| `pg_dash_tables` | 所有表的大小和行数 |
| `pg_dash_table_detail` | 单个表的详细信息 |
| `pg_dash_activity` | 当前活动（查询、连接） |
| `pg_dash_schema_changes` | 最近的 schema 变更 |
| `pg_dash_fix` | 执行安全修复（VACUUM、ANALYZE、REINDEX 等） |
| `pg_dash_alerts` | 告警历史 |
| `pg_dash_explain` | 对 SELECT 查询运行 EXPLAIN ANALYZE（只读） |
| `pg_dash_batch_fix` | 获取批量修复 SQL，可按类别过滤 |
| `pg_dash_slow_queries` | pg_stat_statements 中的慢查询 |
| `pg_dash_table_sizes` | 表大小（数据/索引拆分，前 30） |
| `pg_dash_export` | 导出完整健康报告（JSON 或 Markdown） |
| `pg_dash_diff` | 与上次快照对比当前健康状态 |
| `pg_dash_check_migration` | 分析 migration SQL 的锁表风险、缺失表、破坏性操作 |
| `pg_dash_analyze_query` | 深度 EXPLAIN 分析，自动生成索引建议 |
| `pg_dash_query_regressions` | 检测比历史基线慢超过 50% 的查询 |
| `pg_dash_compare_env` | 对比两个数据库环境的 Schema 和健康状态 |
| `pg_dash_unused_indexes` | 发现从未被使用的索引（浪费空间、拖慢写入） |
| `pg_dash_bloat` | 检测表膨胀（dead tuples 过多） |
| `pg_dash_autovacuum` | Autovacuum 健康状态——哪些表长期未 vacuum |
| `pg_dash_locks` | 显示活跃锁等待链和长时间阻塞的查询 |
| `pg_dash_config_check` | 审计 PostgreSQL 配置，给出调优建议 |

## MCP 配置

将 pg-dash 接入 Claude Desktop 或 Cursor，实现 AI 辅助的数据库管理。

### Claude Desktop

在 macOS 上编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`，Windows 上编辑 `%APPDATA%\Claude\claude_desktop_config.json`：

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

在项目的 `.cursor/mcp.json` 中添加：

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

### 示例对话

连接后，你可以直接问 AI 助手：

**诊断问题：**
- "我的数据库现在有什么问题？"
- "为什么我的 `users` 表这么慢？检查一下缺失的索引。"
- "显示本周最慢的 5 条查询。"

**性能优化：**
- "一次性生成 SQL，修复所有缺失的外键索引。"
- "帮我分析这条查询：SELECT * FROM orders WHERE user_id = 123"
- "哪些表占用空间最多？"

**迁移前检查：**
- "跑一次健康检查，告诉我现在部署安不安全。"
- "上周以来 schema 有哪些变化？"
- "检查是否有空闲连接会阻塞我的迁移。"

## CI 集成

### GitHub Actions

使用 `--ci` 和 `--diff` 标志集成到 CI 流水线：

```bash
# GitHub Actions 注解（::error::、::warning::）
pg-dash check postgres://... --ci

# 适合 PR 评论的 Markdown 报告
pg-dash check postgres://... --ci --format md

# 与上次运行对比
pg-dash check postgres://... --diff

# 全部组合
pg-dash check postgres://... --ci --diff --format md
```

示例工作流（`.github/workflows/pg-check.yml`）：

```yaml
name: Database Health Check
on:
  push:
    paths: ['migrations/**', 'prisma/**', 'drizzle/**', 'supabase/migrations/**']
  pull_request:
    paths: ['migrations/**', 'prisma/**', 'drizzle/**', 'supabase/migrations/**']
  schedule:
    - cron: '0 8 * * 1'  # 每周一 UTC 早 8 点
jobs:
  db-health:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # 缓存快照，解决 ephemeral runner 丢失 ~/.pg-dash 的问题
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

完整工作流（包含 PR 评论）请参考 [`examples/github-actions-pg-check.yml`](examples/github-actions-pg-check.yml)。

## 健康检查

pg-dash 运行 46+ 项自动化检查：

**性能**
- 缺失索引（大表上的高频顺序扫描）
- 膨胀索引（索引大小 vs 表大小）
- 表膨胀（死元组比例）
- 每张表的缓存效率
- 慢查询（来自 pg_stat_statements）

**维护**
- VACUUM 过期
- ANALYZE 过期
- Transaction ID 回卷风险
- 空闲连接检测
- Idle in transaction 检测

**Schema**
- 缺失主键
- 未使用的索引（0 次扫描，>1MB）
- 重复索引
- 缺失外键索引

**安全**
- 远程超级用户连接
- SSL 未启用
- Trust 认证（无密码）

## CI/CD 集成

```bash
# 健康分低于 70 时让流水线失败
pg-dash check postgres://... --threshold 70 --format json

# GitHub Actions 示例
- name: Database Health Check
  run: npx @indiekitai/pg-dash check ${{ secrets.DATABASE_URL }} --threshold 70
```

## 数据存储

pg-dash 将指标存储在本地 `~/.pg-dash/` 目录：
- `metrics.db` —— 时序指标（保留 7 天）
- `schema.db` —— Schema 快照和变更历史
- `alerts.db` —— 告警规则和历史

全部使用 SQLite，无外部依赖。删除该目录即可重置。

## 技术栈

- **后端**：Hono + Node.js
- **前端**：React + Tailwind CSS（已打包）
- **存储**：SQLite (better-sqlite3)
- **图表**：Recharts
- **无需任何外部服务**

## 环境要求

- Node.js 18+
- PostgreSQL 12+（部分功能需要 15+）

## 许可证

MIT

---

由 [IndieKit](https://github.com/indiekitai) 构建 🛠️
