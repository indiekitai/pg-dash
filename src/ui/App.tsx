import React, { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area, CartesianGrid,
} from "recharts";

// ── Types ──────────────────────────────────────────────────────────────

interface Overview {
  version: string;
  uptime: string;
  dbSize: string;
  databaseCount: number;
  connections: { active: number; idle: number; max: number };
}

interface Database {
  name: string;
  size: string;
  size_bytes: string;
}

interface TableRow {
  schema: string;
  name: string;
  total_size: string;
  size_bytes: string;
  rows: number;
  dead_tuples: number;
  dead_pct: number;
}

interface ActivityRow {
  pid: number;
  query: string;
  state: string;
  wait_event: string | null;
  wait_event_type: string | null;
  duration: string | null;
  client_addr: string | null;
  application_name: string;
}

interface MetricPoint {
  timestamp: number;
  value: number;
}

interface AdvisorIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  category: "performance" | "maintenance" | "schema" | "security";
  title: string;
  description: string;
  fix: string;
  impact: string;
  effort: "quick" | "moderate" | "involved";
}

interface AdvisorResult {
  score: number;
  grade: string;
  issues: AdvisorIssue[];
  breakdown: Record<string, { score: number; grade: string; count: number }>;
}

interface SchemaTable {
  name: string;
  schema: string;
  total_size: string;
  total_size_bytes: string;
  table_size: string;
  index_size: string;
  row_count: number;
  description: string | null;
}

interface TableDetail {
  name: string;
  schema: string;
  total_size: string;
  table_size: string;
  index_size: string;
  toast_size: string;
  row_count: number;
  dead_tuples: number;
  last_vacuum: string | null;
  last_autovacuum: string | null;
  last_analyze: string | null;
  last_autoanalyze: string | null;
  seq_scan: number;
  idx_scan: number;
  columns: { name: string; type: string; nullable: boolean; default_value: string | null; description: string | null }[];
  indexes: { name: string; type: string; size: string; definition: string; is_unique: boolean; is_primary: boolean; idx_scan: number; idx_tup_read: number; idx_tup_fetch: number }[];
  constraints: { name: string; type: string; definition: string }[];
  foreignKeys: { name: string; column_name: string; referenced_table: string; referenced_column: string }[];
  sampleData: any[];
}

// ── Hooks ──────────────────────────────────────────────────────────────

function useFetch<T>(url: string, refreshMs = 30000): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        if (active) { setData(json); setError(null); }
      } catch (e: any) { if (active) setError(e.message); }
    };
    load();
    const iv = setInterval(load, refreshMs);
    return () => { active = false; clearInterval(iv); };
  }, [url, refreshMs, tick]);
  return { data, error, reload };
}

function useWebSocket() {
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let backoff = 1000;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onopen = () => { setConnected(true); backoff = 1000; };
      ws.onclose = () => { setConnected(false); reconnectTimer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); };
      ws.onerror = () => ws?.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "metrics") setMetrics(msg.data);
          if (msg.type === "activity") setActivity(msg.data);
        } catch {}
      };
    };
    connect();
    return () => { clearTimeout(reconnectTimer); ws?.close(); };
  }, []);

  return { metrics, activity, connected };
}

// ── Shared Components ──────────────────────────────────────────────────

const RANGES = ["5m", "15m", "1h", "6h", "24h", "7d"] as const;
type Range = (typeof RANGES)[number];

const gradeColors: Record<string, string> = {
  A: "text-green-400 border-green-400",
  B: "text-blue-400 border-blue-400",
  C: "text-yellow-400 border-yellow-400",
  D: "text-orange-400 border-orange-400",
  F: "text-red-400 border-red-400",
};

const gradeBg: Record<string, string> = {
  A: "bg-green-900/30",
  B: "bg-blue-900/30",
  C: "bg-yellow-900/30",
  D: "bg-orange-900/30",
  F: "bg-red-900/30",
};

const severityBadge: Record<string, string> = {
  critical: "bg-red-900 text-red-300",
  warning: "bg-yellow-900 text-yellow-300",
  info: "bg-blue-900 text-blue-300",
};

const categoryColors: Record<string, string> = {
  performance: "bg-purple-900 text-purple-300",
  maintenance: "bg-teal-900 text-teal-300",
  schema: "bg-indigo-900 text-indigo-300",
  security: "bg-red-900 text-red-300",
};

const effortBadge: Record<string, string> = {
  quick: "text-green-400",
  moderate: "text-yellow-400",
  involved: "text-orange-400",
};

const stateColor: Record<string, string> = {
  active: "text-green-400",
  "idle in transaction": "text-yellow-400",
  idle: "text-gray-500",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 rounded cursor-pointer"
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
    >{copied ? "✓ Copied" : "Copy SQL"}</button>
  );
}

function Toast({ message, type, onClose }: { message: string; type: "success" | "error"; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className={`fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg z-50 ${type === "success" ? "bg-green-900 text-green-200" : "bg-red-900 text-red-200"}`}>
      {message}
    </div>
  );
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatBytes(bytes: number) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function MetricCard({ label, value, unit, sparkData }: { label: string; value: string | number; unit?: string; sparkData?: MetricPoint[] }) {
  return (
    <div className="bg-gray-900 rounded-xl p-4 flex flex-col">
      <div className="text-xs text-gray-400 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1">
        {value}{unit && <span className="text-sm text-gray-400 ml-1">{unit}</span>}
      </div>
      {sparkData && sparkData.length > 1 && (
        <div className="mt-2 h-10">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparkData}>
              <Line type="monotone" dataKey="value" stroke="#6366f1" dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function TimeSeriesChart({ title, metrics, range, colors }: {
  title: string;
  metrics: { key: string; label: string }[];
  range: Range;
  colors: string[];
}) {
  const [data, setData] = useState<Record<string, MetricPoint[]>>({});
  useEffect(() => {
    const load = async () => {
      const result: Record<string, MetricPoint[]> = {};
      await Promise.all(
        metrics.map(async (m) => {
          try { const r = await fetch(`/api/metrics?metric=${m.key}&range=${range}`); result[m.key] = await r.json(); }
          catch { result[m.key] = []; }
        })
      );
      setData(result);
    };
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [range, metrics.map(m => m.key).join(",")]);

  const merged = mergeTimeSeries(data, metrics.map(m => m.key));
  if (merged.length < 2) {
    return (
      <div className="bg-gray-900 rounded-xl p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-2">{title}</h3>
        <div className="h-48 flex items-center justify-center text-gray-600">Collecting data...</div>
      </div>
    );
  }
  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-2">{title}</h3>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={merged}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#9ca3af" }} />
            <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} />
            <Tooltip contentStyle={{ background: "#1f2937", border: "none", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#9ca3af" }} />
            {metrics.map((m, i) => (
              <Area key={m.key} type="monotone" dataKey={m.key} name={m.label} stroke={colors[i]} fill={colors[i]} fillOpacity={0.15} strokeWidth={1.5} dot={false} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function mergeTimeSeries(data: Record<string, MetricPoint[]>, keys: string[]) {
  const map = new Map<number, Record<string, any>>();
  for (const key of keys) {
    for (const pt of data[key] || []) {
      const bucket = Math.round(pt.timestamp / 30000) * 30000;
      if (!map.has(bucket)) map.set(bucket, { time: formatTime(bucket) });
      map.get(bucket)![key] = Math.round(pt.value * 100) / 100;
    }
  }
  return Array.from(map.entries()).sort(([a], [b]) => a - b).map(([, v]) => v);
}

// ── Tab: Overview ──────────────────────────────────────────────────────

function OverviewTab({ overview, liveMetrics, sparklines, databases, tables, range, setRange }: {
  overview: Overview | null; liveMetrics: Record<string, number>; sparklines: Record<string, MetricPoint[]>;
  databases: Database[] | null; tables: TableRow[] | null; range: Range; setRange: (r: Range) => void;
}) {
  const [sortCol, setSortCol] = useState<"size_bytes" | "rows" | "dead_tuples">("size_bytes");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };
  const sortedTables = tables?.slice().sort((a, b) => {
    const va = Number(a[sortCol]), vb = Number(b[sortCol]);
    return sortDir === "desc" ? vb - va : va - vb;
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Active Connections" value={liveMetrics.connections_active ?? overview?.connections.active ?? "—"} unit={overview ? `/ ${overview.connections.max}` : undefined} sparkData={sparklines.connections_active} />
        <MetricCard label="TPS (commit)" value={liveMetrics.tps_commit !== undefined ? liveMetrics.tps_commit.toFixed(1) : "—"} unit="tx/s" sparkData={sparklines.tps_commit} />
        <MetricCard label="Cache Hit Ratio" value={liveMetrics.cache_hit_ratio !== undefined ? (liveMetrics.cache_hit_ratio * 100).toFixed(2) : "—"} unit="%" sparkData={sparklines.cache_hit_ratio} />
        <MetricCard label="DB Size" value={liveMetrics.db_size_bytes !== undefined ? formatBytes(liveMetrics.db_size_bytes) : overview?.dbSize ?? "—"} sparkData={sparklines.db_size_bytes} />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm text-gray-400">Range:</span>
          {RANGES.map((r) => (
            <button key={r} className={`px-2 py-1 text-xs rounded cursor-pointer ${range === r ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TimeSeriesChart title="Connections" metrics={[{ key: "connections_active", label: "Active" }, { key: "connections_idle", label: "Idle" }]} range={range} colors={["#22c55e", "#6366f1"]} />
          <TimeSeriesChart title="Transactions per Second" metrics={[{ key: "tps_commit", label: "Commit" }, { key: "tps_rollback", label: "Rollback" }]} range={range} colors={["#22c55e", "#ef4444"]} />
          <TimeSeriesChart title="Cache Hit Ratio" metrics={[{ key: "cache_hit_ratio", label: "Ratio" }]} range={range} colors={["#f59e0b"]} />
          <TimeSeriesChart title="Tuple Operations / sec" metrics={[{ key: "tuple_inserted", label: "Insert" }, { key: "tuple_updated", label: "Update" }, { key: "tuple_deleted", label: "Delete" }]} range={range} colors={["#22c55e", "#3b82f6", "#ef4444"]} />
        </div>
      </div>

      {databases && (
        <div className="bg-gray-900 rounded-xl p-4">
          <h2 className="text-lg font-semibold mb-3">Databases ({databases.length})</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {databases.map((db) => (
              <div key={db.name} className="bg-gray-800 rounded-lg px-3 py-2 text-sm">
                <div className="font-medium">{db.name}</div>
                <div className="text-gray-400 text-xs">{db.size}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {sortedTables && (
        <div className="bg-gray-900 rounded-xl p-4 overflow-x-auto">
          <h2 className="text-lg font-semibold mb-3">Tables ({sortedTables.length})</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-800">
                <th className="py-2 px-2">Table</th>
                <th className="py-2 px-2 cursor-pointer" onClick={() => toggleSort("size_bytes")}>Size {sortCol === "size_bytes" && (sortDir === "desc" ? "↓" : "↑")}</th>
                <th className="py-2 px-2 cursor-pointer" onClick={() => toggleSort("rows")}>Rows {sortCol === "rows" && (sortDir === "desc" ? "↓" : "↑")}</th>
                <th className="py-2 px-2 cursor-pointer" onClick={() => toggleSort("dead_tuples")}>Dead Tuples {sortCol === "dead_tuples" && (sortDir === "desc" ? "↓" : "↑")}</th>
                <th className="py-2 px-2">Bloat %</th>
              </tr>
            </thead>
            <tbody>
              {sortedTables.map((t) => (
                <tr key={`${t.schema}.${t.name}`} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="py-1.5 px-2 font-mono">{t.schema}.{t.name}</td>
                  <td className="py-1.5 px-2">{t.total_size}</td>
                  <td className="py-1.5 px-2">{Number(t.rows).toLocaleString()}</td>
                  <td className="py-1.5 px-2">{Number(t.dead_tuples).toLocaleString()}</td>
                  <td className="py-1.5 px-2">{t.dead_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Tab: Health ────────────────────────────────────────────────────────

function HealthTab() {
  const { data: advisor, reload } = useFetch<AdvisorResult>("/api/advisor", 120000);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [fixModal, setFixModal] = useState<{ sql: string; title: string } | null>(null);
  const [executing, setExecuting] = useState(false);

  const executeFix = async (sql: string) => {
    setExecuting(true);
    try {
      const r = await fetch("/api/fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
      const result = await r.json();
      if (result.ok) {
        setToast({ message: `Fix executed successfully (${result.duration}ms)`, type: "success" });
        setFixModal(null);
        reload();
      } else {
        setToast({ message: `Error: ${result.error}`, type: "error" });
      }
    } catch (e: any) {
      setToast({ message: `Error: ${e.message}`, type: "error" });
    } finally {
      setExecuting(false);
    }
  };

  if (!advisor) return <div className="text-gray-500">Loading advisor report...</div>;

  const filtered = advisor.issues.filter((i) =>
    (filterSeverity === "all" || i.severity === filterSeverity) &&
    (filterCategory === "all" || i.category === filterCategory)
  );

  const categories = ["performance", "maintenance", "schema", "security"] as const;

  return (
    <div className="space-y-6">
      {/* Health Score */}
      <div className="flex flex-wrap gap-6 items-start">
        <div className={`flex flex-col items-center justify-center w-40 h-40 rounded-full border-4 ${gradeColors[advisor.grade]} ${gradeBg[advisor.grade]}`}>
          <span className="text-5xl font-black">{advisor.grade}</span>
          <span className="text-lg font-semibold">{advisor.score}/100</span>
        </div>
        <div className="flex-1 min-w-[300px]">
          <h2 className="text-lg font-semibold mb-3">Category Breakdown</h2>
          <div className="grid grid-cols-2 gap-3">
            {categories.map((cat) => {
              const b = advisor.breakdown[cat];
              return (
                <div key={cat} className="bg-gray-900 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <span className="capitalize text-sm">{cat}</span>
                    <span className={`font-bold ${gradeColors[b.grade]?.split(" ")[0]}`}>{b.grade}</span>
                  </div>
                  <div className="mt-1 bg-gray-800 rounded-full h-2">
                    <div className={`h-2 rounded-full ${b.score >= 90 ? "bg-green-500" : b.score >= 70 ? "bg-yellow-500" : b.score >= 50 ? "bg-orange-500" : "bg-red-500"}`} style={{ width: `${b.score}%` }} />
                  </div>
                  <div className="text-xs text-gray-400 mt-1">{b.count} issue{b.count !== 1 ? "s" : ""} · {b.score}/100</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Filters + Re-scan */}
      <div className="flex flex-wrap items-center gap-3">
        <select className="bg-gray-800 text-sm rounded px-3 py-1.5 border border-gray-700" value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value)}>
          <option value="all">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select className="bg-gray-800 text-sm rounded px-3 py-1.5 border border-gray-700" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="all">All Categories</option>
          <option value="performance">Performance</option>
          <option value="maintenance">Maintenance</option>
          <option value="schema">Schema</option>
          <option value="security">Security</option>
        </select>
        <button className="ml-auto px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded cursor-pointer" onClick={reload}>↻ Re-scan</button>
      </div>

      {/* Issues */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <p className="text-green-400 bg-gray-900 rounded-xl p-6 text-center">✅ No issues found!</p>
        ) : (
          filtered.map((issue) => (
            <div key={issue.id} className="bg-gray-900 rounded-xl p-4">
              <div className="flex items-start gap-3 cursor-pointer" onClick={() => setExpandedId(expandedId === issue.id ? null : issue.id)}>
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${severityBadge[issue.severity]}`}>{issue.severity}</span>
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${categoryColors[issue.category]}`}>{issue.category}</span>
                <div className="flex-1">
                  <div className="font-medium">{issue.title}</div>
                  <div className="text-sm text-gray-400 mt-0.5">{issue.description}</div>
                </div>
                <span className={`text-xs whitespace-nowrap ${effortBadge[issue.effort]}`}>⏱ {issue.effort}</span>
                <span className="text-gray-500">{expandedId === issue.id ? "▲" : "▼"}</span>
              </div>
              {expandedId === issue.id && (
                <div className="mt-3 pl-4 border-l-2 border-gray-700 space-y-2">
                  <div><span className="text-xs text-gray-400 uppercase">Impact:</span> <span className="text-sm">{issue.impact}</span></div>
                  <div>
                    <span className="text-xs text-gray-400 uppercase">Fix:</span>
                    <pre className="mt-1 bg-gray-800 rounded p-3 text-xs font-mono text-gray-300 whitespace-pre-wrap">{issue.fix}</pre>
                  </div>
                  <div className="flex gap-2">
                    <CopyButton text={issue.fix} />
                    <button
                      className="px-2 py-0.5 text-xs bg-green-800 hover:bg-green-700 text-green-200 rounded cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); setFixModal({ sql: issue.fix, title: issue.title }); }}
                    >▶ Execute Fix</button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Fix Modal */}
      {fixModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setFixModal(null)}>
          <div className="bg-gray-900 rounded-xl p-6 max-w-lg w-full mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">Execute Fix: {fixModal.title}</h3>
            <pre className="bg-gray-800 rounded p-3 text-sm font-mono text-gray-300 whitespace-pre-wrap max-h-60 overflow-y-auto">{fixModal.sql}</pre>
            <p className="text-sm text-yellow-400">⚠️ This will execute the SQL above on your database. Are you sure?</p>
            <div className="flex gap-3 justify-end">
              <button className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 rounded cursor-pointer" onClick={() => setFixModal(null)}>Cancel</button>
              <button
                className="px-4 py-2 text-sm bg-green-700 hover:bg-green-600 rounded cursor-pointer disabled:opacity-50"
                disabled={executing}
                onClick={() => executeFix(fixModal.sql)}
              >{executing ? "Executing..." : "Execute"}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ── Tab: Schema ────────────────────────────────────────────────────────

function SchemaTab() {
  const { data: tables } = useFetch<SchemaTable[]>("/api/schema/tables", 60000);
  const { data: extensions } = useFetch<{ name: string; installed_version: string; schema: string; description: string | null }[]>("/api/schema/extensions", 120000);
  const { data: enums } = useFetch<{ name: string; schema: string; values: string[] }[]>("/api/schema/enums", 120000);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [detailTab, setDetailTab] = useState<"columns" | "indexes" | "constraints" | "fkeys" | "sample">("columns");
  const [search, setSearch] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);

  const loadDetail = async (name: string) => {
    setSelectedTable(name);
    setLoadingDetail(true);
    setDetailTab("columns");
    try {
      const r = await fetch(`/api/schema/tables/${name}`);
      if (r.ok) setDetail(await r.json());
    } catch {}
    setLoadingDetail(false);
  };

  const filteredTables = tables?.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <div className="flex gap-4 h-[calc(100vh-12rem)]">
      {/* Sidebar */}
      <div className="w-64 flex-shrink-0 bg-gray-900 rounded-xl p-3 overflow-y-auto">
        <input className="w-full bg-gray-800 rounded px-3 py-1.5 text-sm mb-3 border border-gray-700" placeholder="Search tables..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="space-y-1">
          {filteredTables.map((t) => (
            <button
              key={`${t.schema}.${t.name}`}
              className={`w-full text-left px-3 py-2 rounded text-sm cursor-pointer ${selectedTable === t.name ? "bg-indigo-600/30 text-indigo-300" : "hover:bg-gray-800"}`}
              onClick={() => loadDetail(t.name)}
            >
              <div className="font-mono">{t.name}</div>
              <div className="text-xs text-gray-500">{t.total_size} · {Number(t.row_count).toLocaleString()} rows</div>
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 overflow-y-auto space-y-4">
        {!selectedTable && (
          <div className="space-y-4">
            <div className="bg-gray-900 rounded-xl p-6 text-center text-gray-500">Select a table from the sidebar</div>
            {extensions && extensions.length > 0 && (
              <div className="bg-gray-900 rounded-xl p-4">
                <h3 className="text-lg font-semibold mb-3">Extensions ({extensions.length})</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {extensions.map((e) => (
                    <div key={e.name} className="bg-gray-800 rounded-lg px-3 py-2 text-sm">
                      <div className="font-medium">{e.name} <span className="text-gray-400 text-xs">v{e.installed_version}</span></div>
                      {e.description && <div className="text-xs text-gray-500 mt-0.5">{e.description}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {enums && enums.length > 0 && (
              <div className="bg-gray-900 rounded-xl p-4">
                <h3 className="text-lg font-semibold mb-3">Enum Types ({enums.length})</h3>
                <div className="space-y-2">
                  {enums.map((e) => (
                    <div key={e.name} className="bg-gray-800 rounded-lg px-3 py-2 text-sm">
                      <span className="font-mono font-medium">{e.name}</span>
                      <span className="text-gray-400 ml-2">{e.values.join(", ")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {selectedTable && loadingDetail && <div className="bg-gray-900 rounded-xl p-6 text-center text-gray-500">Loading...</div>}

        {selectedTable && detail && !loadingDetail && (
          <>
            {/* Header */}
            <div className="bg-gray-900 rounded-xl p-4">
              <h2 className="text-xl font-bold font-mono">{detail.schema}.{detail.name}</h2>
              <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-400">
                <span>Total: {detail.total_size}</span>
                <span>Table: {detail.table_size}</span>
                <span>Indexes: {detail.index_size}</span>
                <span>Toast: {detail.toast_size || "0 bytes"}</span>
                <span>Rows: {Number(detail.row_count).toLocaleString()}</span>
                <span>Dead: {Number(detail.dead_tuples).toLocaleString()}</span>
                <span>Seq scans: {detail.seq_scan}</span>
                <span>Idx scans: {detail.idx_scan}</span>
              </div>
            </div>

            {/* Detail Tabs */}
            <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
              {(["columns", "indexes", "constraints", "fkeys", "sample"] as const).map((tab) => (
                <button
                  key={tab}
                  className={`px-3 py-1.5 text-sm rounded cursor-pointer ${detailTab === tab ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800"}`}
                  onClick={() => setDetailTab(tab)}
                >{tab === "fkeys" ? "Foreign Keys" : tab.charAt(0).toUpperCase() + tab.slice(1)}</button>
              ))}
            </div>

            <div className="bg-gray-900 rounded-xl p-4 overflow-x-auto">
              {detailTab === "columns" && (
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">Name</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Nullable</th><th className="py-2 px-2">Default</th><th className="py-2 px-2">Description</th>
                  </tr></thead>
                  <tbody>{detail.columns.map((col) => (
                    <tr key={col.name} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 font-mono">{col.name}</td>
                      <td className="py-1.5 px-2 text-indigo-300">{col.type}</td>
                      <td className="py-1.5 px-2">{col.nullable ? "✓" : ""}</td>
                      <td className="py-1.5 px-2 text-xs font-mono text-gray-400">{col.default_value || ""}</td>
                      <td className="py-1.5 px-2 text-xs text-gray-500">{col.description || ""}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {detailTab === "indexes" && (
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">Name</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Size</th><th className="py-2 px-2">Scans</th><th className="py-2 px-2">Reads</th><th className="py-2 px-2">Props</th>
                  </tr></thead>
                  <tbody>{detail.indexes.map((idx) => (
                    <tr key={idx.name} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 font-mono">{idx.name}</td>
                      <td className="py-1.5 px-2">{idx.type}</td>
                      <td className="py-1.5 px-2">{idx.size}</td>
                      <td className="py-1.5 px-2">{idx.idx_scan?.toLocaleString() ?? "—"}</td>
                      <td className="py-1.5 px-2">{idx.idx_tup_read?.toLocaleString() ?? "—"}</td>
                      <td className="py-1.5 px-2 text-xs">{[idx.is_primary && "PK", idx.is_unique && "UNIQUE"].filter(Boolean).join(", ") || "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {detailTab === "constraints" && (
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">Name</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Definition</th>
                  </tr></thead>
                  <tbody>{detail.constraints.map((c) => (
                    <tr key={c.name} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 font-mono">{c.name}</td>
                      <td className="py-1.5 px-2">{c.type}</td>
                      <td className="py-1.5 px-2 text-xs font-mono text-gray-400">{c.definition}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {detailTab === "fkeys" && (
                detail.foreignKeys.length === 0 ? <p className="text-gray-500">No foreign keys</p> :
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">Name</th><th className="py-2 px-2">Column</th><th className="py-2 px-2">→ Table</th><th className="py-2 px-2">→ Column</th>
                  </tr></thead>
                  <tbody>{detail.foreignKeys.map((fk) => (
                    <tr key={fk.name + fk.column_name} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 font-mono">{fk.name}</td>
                      <td className="py-1.5 px-2">{fk.column_name}</td>
                      <td className="py-1.5 px-2 text-indigo-300 cursor-pointer hover:underline" onClick={() => loadDetail(fk.referenced_table)}>{fk.referenced_table}</td>
                      <td className="py-1.5 px-2">{fk.referenced_column}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {detailTab === "sample" && (
                detail.sampleData.length === 0 ? <p className="text-gray-500">No data</p> :
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                      {Object.keys(detail.sampleData[0]).map((k) => <th key={k} className="py-2 px-2 whitespace-nowrap">{k}</th>)}
                    </tr></thead>
                    <tbody>{detail.sampleData.map((row, i) => (
                      <tr key={i} className="border-b border-gray-800/50">
                        {Object.values(row).map((v, j) => <td key={j} className="py-1.5 px-2 text-xs font-mono max-w-xs truncate">{String(v ?? "NULL")}</td>)}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Tab: Activity ──────────────────────────────────────────────────────

function ActivityTab({ activity }: { activity: ActivityRow[] }) {
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const cancelQuery = async (pid: number) => {
    if (!confirm(`Cancel query on PID ${pid}?`)) return;
    try {
      await fetch(`/api/activity/${pid}/cancel`, { method: "POST" });
      setToast({ message: `Cancelled PID ${pid}`, type: "success" });
    } catch (e: any) {
      setToast({ message: e.message, type: "error" });
    }
  };

  const nonIdle = activity.filter((a) => a.state !== "idle");
  const idle = activity.filter((a) => a.state === "idle");

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-xl p-4 overflow-x-auto">
        <h2 className="text-lg font-semibold mb-3">Active Queries ({nonIdle.length})</h2>
        {nonIdle.length === 0 ? <p className="text-gray-500 text-sm">No active queries</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-gray-400 text-left border-b border-gray-800">
              <th className="py-2 px-2">PID</th><th className="py-2 px-2">Duration</th><th className="py-2 px-2">State</th><th className="py-2 px-2">Wait</th><th className="py-2 px-2">Query</th><th className="py-2 px-2">Client</th><th className="py-2 px-2"></th>
            </tr></thead>
            <tbody>
              {nonIdle.map((a) => (
                <React.Fragment key={a.pid}>
                  <tr className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer" onClick={() => setExpandedPid(expandedPid === a.pid ? null : a.pid)}>
                    <td className="py-1.5 px-2 font-mono">{a.pid}</td>
                    <td className="py-1.5 px-2">{a.duration || "—"}</td>
                    <td className={`py-1.5 px-2 ${stateColor[a.state] || "text-gray-400"}`}>{a.state}</td>
                    <td className="py-1.5 px-2 text-xs">{a.wait_event || "—"}</td>
                    <td className="py-1.5 px-2 font-mono text-xs max-w-md truncate">{a.query}</td>
                    <td className="py-1.5 px-2 text-xs">{a.client_addr || "local"}</td>
                    <td className="py-1.5 px-2">
                      {(a.state === "active" || a.state === "idle in transaction") && (
                        <button className="text-xs text-red-400 hover:text-red-300 cursor-pointer" onClick={(e) => { e.stopPropagation(); cancelQuery(a.pid); }}>Cancel</button>
                      )}
                    </td>
                  </tr>
                  {expandedPid === a.pid && (
                    <tr className="bg-gray-800/50"><td colSpan={7} className="px-4 py-3"><pre className="text-xs font-mono whitespace-pre-wrap text-gray-300">{a.query}</pre></td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-gray-900 rounded-xl p-4 overflow-x-auto">
        <h2 className="text-lg font-semibold mb-3">Idle Connections ({idle.length})</h2>
        {idle.length === 0 ? <p className="text-gray-500 text-sm">No idle connections</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-gray-400 text-left border-b border-gray-800">
              <th className="py-2 px-2">PID</th><th className="py-2 px-2">App</th><th className="py-2 px-2">Client</th>
            </tr></thead>
            <tbody>{idle.map((a) => (
              <tr key={a.pid} className="border-b border-gray-800/50">
                <td className="py-1.5 px-2 font-mono">{a.pid}</td>
                <td className="py-1.5 px-2 text-xs">{a.application_name || "—"}</td>
                <td className="py-1.5 px-2 text-xs">{a.client_addr || "local"}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────

type Tab = "overview" | "health" | "schema" | "activity";

export default function App() {
  const { data: overview } = useFetch<Overview>("/api/overview");
  const { data: health } = useFetch<AdvisorResult>("/api/advisor", 60000);
  const { data: databases } = useFetch<Database[]>("/api/databases", 60000);
  const { data: tables } = useFetch<TableRow[]>("/api/tables", 60000);
  const { metrics: liveMetrics, activity: liveActivity, connected } = useWebSocket();
  const [range, setRange] = useState<Range>("1h");
  const [tab, setTab] = useState<Tab>("overview");

  const [sparklines, setSparklines] = useState<Record<string, MetricPoint[]>>({});
  useEffect(() => {
    const load = async () => {
      const keys = ["connections_active", "tps_commit", "cache_hit_ratio", "db_size_bytes"];
      const result: Record<string, MetricPoint[]> = {};
      await Promise.all(keys.map(async (k) => {
        try { const r = await fetch(`/api/metrics?metric=${k}&range=15m`); result[k] = await r.json(); }
        catch { result[k] = []; }
      }));
      setSparklines(result);
    };
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "health", label: "Health" },
    { id: "schema", label: "Schema" },
    { id: "activity", label: "Activity" },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">🐘 pg-dash</h1>
          {health && (
            <span className={`text-xl font-black border-2 rounded-lg px-2 py-0.5 ${gradeColors[health.grade] || "border-gray-600"}`}>
              {health.grade}
            </span>
          )}
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} title={connected ? "Live" : "Disconnected"} />
        </div>
        {overview && (
          <div className="text-sm text-gray-400 flex flex-wrap gap-x-4">
            <span>PostgreSQL {overview.version}</span>
            <span>Uptime: {overview.uptime}</span>
            <span>Size: {overview.dbSize}</span>
          </div>
        )}
      </header>

      {/* Tab Navigation */}
      <nav className="flex gap-1 bg-gray-900 rounded-xl p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`px-4 py-2 text-sm rounded-lg cursor-pointer transition-colors ${tab === t.id ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "activity" && liveActivity.filter(a => a.state !== "idle").length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-green-600 rounded-full">{liveActivity.filter(a => a.state !== "idle").length}</span>
            )}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      {tab === "overview" && <OverviewTab overview={overview} liveMetrics={liveMetrics} sparklines={sparklines} databases={databases} tables={tables} range={range} setRange={setRange} />}
      {tab === "health" && <HealthTab />}
      {tab === "schema" && <SchemaTab />}
      {tab === "activity" && <ActivityTab activity={liveActivity} />}
    </div>
  );
}
