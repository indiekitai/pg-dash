[English](README.md) | [中文](README.zh-CN.md)

# pg-dash

**轻量级 PostgreSQL 监控面板。** 一条命令启动，内置 Web UI，提供可操作的修复建议。

可以理解为**给独立开发者的 pganalyze** —— 不需要 Grafana，不需要 Prometheus，不需要 Docker。只需 `npx` 即可运行。

```bash
npx @indiekitai/pg-dash postgres://user:pass@host/db
```

## 为什么选 pg-dash？

| 工具 | 价格 | 部署 | 适合 |
|------|------|------|------|
| pganalyze | $149+/月 | SaaS 注册 | 企业 |
| Grafana+Prometheus | 免费 | 配置 3 个服务 | DevOps 团队 |
| pgAdmin | 免费 | 界面复杂 | DBA |
| **pg-dash** | **免费** | **一条命令** | **开发者** |

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

### 🤖 MCP Server
- 8 个工具，支持 AI Agent 集成
- `pg-dash-mcp postgres://...` —— 可配合 Claude、Cursor 等使用

### 🖥️ CLI
```bash
# 启动面板
pg-dash postgres://user:pass@host/db

# 健康检查（适合 CI/CD）
pg-dash check postgres://user:pass@host/db
pg-dash check postgres://... --format json --threshold 70

# Schema 变更
pg-dash schema-diff postgres://user:pass@host/db

# JSON 输出
pg-dash postgres://... --json
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
pg-dash <connection-string>          启动面板
pg-dash check <connection-string>    运行健康检查并退出
pg-dash schema-diff <connection-string>  显示 Schema 变更

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
  -f, --format <fmt>     输出格式：text|json（默认：text）
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

可用工具：`pg_dash_overview`、`pg_dash_health`、`pg_dash_tables`、`pg_dash_table_detail`、`pg_dash_activity`、`pg_dash_schema_changes`、`pg_dash_fix`、`pg_dash_alerts`

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
