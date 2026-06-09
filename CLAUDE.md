# pg-dash CLAUDE.md

> `@indiekitai/pg-dash` — 轻量 PostgreSQL 监控工具（Web Dashboard + CLI + MCP Server）。
> npm 包名 `@indiekitai/pg-dash`，GitHub `indiekitai/pg-dash`。

---

## 项目结构

```
src/
├── cli.ts            # CLI 入口（pg-dash 命令）
├── mcp.ts            # MCP Server 入口（pg-dash-mcp 命令）
├── server/           # 共享的查询/分析逻辑
│   ├── queries/      # PG 查询（overview, tables, schema, activity, slow-queries...）
│   ├── advisor.ts    # 健康检查 + 建议
│   ├── migration-checker.ts  # Migration 安全分析
│   ├── pgvector.ts   # pgvector 扩展健康检查
│   └── ...
└── ui/               # Web Dashboard 前端（React + Recharts + Tailwind）
```

构建产物：
- `dist/cli.js` + `dist/mcp.js` — tsup 打包的后端
- `dist/ui/` — vite 打包的前端静态资源

## 构建与测试

```bash
pnpm build              # 完整构建（后端 + 前端）
pnpm build:backend      # 仅 tsup 打包 cli.ts + mcp.ts
pnpm build:frontend     # 仅 vite 打包 Web Dashboard
pnpm test               # vitest 跑测试
```

---

## 发版纪律（强制）

> 2026-06-09 教训：npm publish 后不 push，导致本地/远端分叉、版本线混乱、0.12.2 带 bug 发到 latest。

### 发版检查清单（每次 npm publish 前必须按序执行）

```
1. git pull origin master          ← 先拉远端，防分叉
2. 改 package.json 版本号
3. 更新 CHANGELOG.md
4. pnpm build                      ← 必须完整 build，不能只 build:backend
5. 验证 dist/ 内容完整：
   - dist/cli.js ✓
   - dist/mcp.js ✓
   - dist/ui/index.html ✓          ← 漏了这个 = Web Dashboard 坏了
   - dist/ui/assets/*.js ✓
6. npm publish --dry-run            ← 先 dry-run 检查 tarball 内容
7. npm publish --tag latest
8. git add -A && git commit
9. git tag v{版本号}
10. git push origin master --tags   ← 不 push = 没发版
```

**禁止**：
- ❌ npm publish 后不 push（这是今天所有问题的根因）
- ❌ 只跑 `build:backend` 就发版（会漏掉 Web Dashboard）
- ❌ 在不同机器/环境上各自发版不合并（会产生并行版本线）
- ❌ 发完版不验证就走（至少 `npx @indiekitai/pg-dash@{version} --version` 跑一下）

### 版本号规则

- 线性递增，不开并行版本线
- `latest` tag 必须指向最新的稳定版
- 如果发错了，用 `npm deprecate` 标记错误版本，不要试图在旧版本线上打补丁

---

## MCP Server 约束（强制）

> 2026-06-09 教训：启动时 pool.connect() 探活输出干扰 MCP stdio 协议握手。

### stdio 模式下的铁律

MCP stdio 协议用 stdin/stdout 通信。**在 `server.connect(transport)` 之前和之外**：

- ❌ 禁止 `console.log()`（会写 stdout，破坏协议）
- ⚠️ `console.error()` 写 stderr，协议上安全但 Claude Code 可能显示为噪音
- ❌ 禁止启动时的 `pool.connect()` 探活——pool 是懒连接，第一次 tool call 时才连
- ❌ 禁止任何会向 stdout 写数据的副作用（uncaught promise rejection 的默认 handler 等）

### 每个 tool handler 的错误处理

pool 连不上时，错误在 tool handler 的 try/catch 里返回 `isError: true`，不在全局抛。这样 MCP 客户端能拿到有意义的错误信息，而不是连接断开。

```typescript
// ✅ 正确：懒连接 + handler 内 catch
server.tool("pg_dash_xxx", "...", {}, async () => {
  try {
    const client = await pool.connect();
    try { /* ... */ } finally { client.release(); }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// ❌ 错误：启动时探活
const pool = new Pool({ connectionString });
pool.connect().then(c => c.release()).catch(console.error);  // 干扰 stdio
```

### 双模式（stdio / HTTP）

`src/mcp.ts` 末尾通过 `--http` 参数切换：
- 默认 = stdio（Claude Code / claude.ai 用）
- `--http` = Streamable HTTP（Web 客户端用，监听 MCP_PORT，默认 8768）

改 transport 初始化逻辑时两条路径都要测。

---

## 改动后怎么测 MCP Server

本地快速验证（不需要启动 Claude Code）：

```bash
# 1. 确保有 PG 连接（SSH 隧道或本地 PG）
# 2. 启动 MCP server，应该静默等待 stdin，无任何输出
PG_DASH_CONNECTION_STRING="postgresql://user:pass@localhost:5432/db" node dist/mcp.js &
MCP_PID=$!
sleep 2

# 如果 2 秒后进程还活着且没有 stderr 输出 = 正常
# 如果立即退出或有 Connection terminated = 有问题
kill $MCP_PID
```

完整验证：在 Claude Code 的 mcp.json 里指向本地 build 的 dist/mcp.js，重启 Claude Code，看 `/mcp` 状态是否 connected。

---

## 已知陷阱

| 陷阱 | 说明 |
|------|------|
| pool.connect() 探活 | 干扰 MCP stdio 协议，已删除，不要加回来 |
| build:backend ≠ build | 只打后端会丢 dist/ui/，Web Dashboard 坏掉 |
| npm publish 不 push | 多环境各自积累 commit 会分叉，merge 痛苦 |
| `^` 依赖 + npx 缓存 | npx 可能缓存旧版依赖，用户升级后行为不一致；重大依赖升级时 pin 版本 |
| better-sqlite3 原生模块 | 换 Node 大版本后需要 rebuild，否则 MCP server 启动 segfault |
