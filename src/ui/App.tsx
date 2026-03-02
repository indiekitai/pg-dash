import React, { useEffect, useState, useRef, useCallback } from "react";
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

interface HealthIssue {
  severity: "info" | "warning" | "critical";
  check: string;
  description: string;
  sql?: string;
}

interface Health {
  score: number;
  grade: string;
  issues: HealthIssue[];
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

// ── Hooks ──────────────────────────────────────────────────────────────

function useFetch<T>(url: string, refreshMs = 30000): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  }, [url, refreshMs]);
  return { data, error };
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
      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
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
    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { metrics, activity, connected };
}

// ── Components ─────────────────────────────────────────────────────────

const RANGES = ["5m", "15m", "1h", "6h", "24h", "7d"] as const;
type Range = (typeof RANGES)[number];

const gradeColors: Record<string, string> = {
  A: "text-green-400 border-green-400",
  B: "text-blue-400 border-blue-400",
  C: "text-yellow-400 border-yellow-400",
  D: "text-orange-400 border-orange-400",
  F: "text-red-400 border-red-400",
};

const severityBadge: Record<string, string> = {
  critical: "bg-red-900 text-red-300",
  warning: "bg-yellow-900 text-yellow-300",
  info: "bg-blue-900 text-blue-300",
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
      className="ml-2 px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 rounded cursor-pointer"
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
    >{copied ? "✓" : "Copy"}</button>
  );
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
          try {
            const r = await fetch(`/api/metrics?metric=${m.key}&range=${range}`);
            result[m.key] = await r.json();
          } catch { result[m.key] = []; }
        })
      );
      setData(result);
    };
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [range, metrics.map(m => m.key).join(",")]);

  // Merge into unified data set by timestamp
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
            <Tooltip
              contentStyle={{ background: "#1f2937", border: "none", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "#9ca3af" }}
            />
            {metrics.map((m, i) => (
              <Area
                key={m.key}
                type="monotone"
                dataKey={m.key}
                name={m.label}
                stroke={colors[i]}
                fill={colors[i]}
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={false}
              />
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
      // Bucket to nearest 30s
      const bucket = Math.round(pt.timestamp / 30000) * 30000;
      if (!map.has(bucket)) map.set(bucket, { time: formatTime(bucket) });
      map.get(bucket)![key] = Math.round(pt.value * 100) / 100;
    }
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);
}

// ── Main App ───────────────────────────────────────────────────────────

export default function App() {
  const { data: overview } = useFetch<Overview>("/api/overview");
  const { data: health } = useFetch<Health>("/api/health", 60000);
  const { data: databases } = useFetch<Database[]>("/api/databases", 60000);
  const { data: tables } = useFetch<TableRow[]>("/api/tables", 60000);
  const { metrics: liveMetrics, activity: liveActivity, connected } = useWebSocket();
  const [range, setRange] = useState<Range>("1h");
  const [sortCol, setSortCol] = useState<"size_bytes" | "rows" | "dead_tuples">("size_bytes");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedPid, setExpandedPid] = useState<number | null>(null);

  // Sparklines (last 15 min)
  const [sparklines, setSparklines] = useState<Record<string, MetricPoint[]>>({});
  useEffect(() => {
    const load = async () => {
      const keys = ["connections_active", "tps_commit", "cache_hit_ratio", "db_size_bytes"];
      const result: Record<string, MetricPoint[]> = {};
      await Promise.all(keys.map(async (k) => {
        try {
          const r = await fetch(`/api/metrics?metric=${k}&range=15m`);
          result[k] = await r.json();
        } catch { result[k] = []; }
      }));
      setSparklines(result);
    };
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  const sortedTables = tables?.slice().sort((a, b) => {
    const va = Number(a[sortCol]), vb = Number(b[sortCol]);
    return sortDir === "desc" ? vb - va : va - vb;
  });

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const cancelQuery = async (pid: number) => {
    if (!confirm(`Cancel query on PID ${pid}?`)) return;
    await fetch(`/api/activity/${pid}/cancel`, { method: "POST" });
  };

  const formatBytes = (bytes: number) => {
    if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
  };

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

      {/* Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          label="Active Connections"
          value={liveMetrics.connections_active ?? overview?.connections.active ?? "—"}
          unit={overview ? `/ ${overview.connections.max}` : undefined}
          sparkData={sparklines.connections_active}
        />
        <MetricCard
          label="TPS (commit)"
          value={liveMetrics.tps_commit !== undefined ? liveMetrics.tps_commit.toFixed(1) : "—"}
          unit="tx/s"
          sparkData={sparklines.tps_commit}
        />
        <MetricCard
          label="Cache Hit Ratio"
          value={liveMetrics.cache_hit_ratio !== undefined ? (liveMetrics.cache_hit_ratio * 100).toFixed(2) : "—"}
          unit="%"
          sparkData={sparklines.cache_hit_ratio}
        />
        <MetricCard
          label="DB Size"
          value={liveMetrics.db_size_bytes !== undefined ? formatBytes(liveMetrics.db_size_bytes) : overview?.dbSize ?? "—"}
          sparkData={sparklines.db_size_bytes}
        />
      </div>

      {/* Time-series charts */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm text-gray-400">Range:</span>
          {RANGES.map((r) => (
            <button
              key={r}
              className={`px-2 py-1 text-xs rounded cursor-pointer ${range === r ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}
              onClick={() => setRange(r)}
            >{r}</button>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TimeSeriesChart
            title="Connections"
            metrics={[
              { key: "connections_active", label: "Active" },
              { key: "connections_idle", label: "Idle" },
            ]}
            range={range}
            colors={["#22c55e", "#6366f1"]}
          />
          <TimeSeriesChart
            title="Transactions per Second"
            metrics={[
              { key: "tps_commit", label: "Commit" },
              { key: "tps_rollback", label: "Rollback" },
            ]}
            range={range}
            colors={["#22c55e", "#ef4444"]}
          />
          <TimeSeriesChart
            title="Cache Hit Ratio"
            metrics={[{ key: "cache_hit_ratio", label: "Ratio" }]}
            range={range}
            colors={["#f59e0b"]}
          />
          <TimeSeriesChart
            title="Tuple Operations / sec"
            metrics={[
              { key: "tuple_inserted", label: "Insert" },
              { key: "tuple_updated", label: "Update" },
              { key: "tuple_deleted", label: "Delete" },
            ]}
            range={range}
            colors={["#22c55e", "#3b82f6", "#ef4444"]}
          />
        </div>
      </div>

      {/* Activity */}
      <div className="bg-gray-900 rounded-xl p-4 overflow-x-auto">
        <h2 className="text-lg font-semibold mb-3">
          Live Activity ({liveActivity.filter(a => a.state !== "idle").length} active)
        </h2>
        {liveActivity.filter(a => a.state !== "idle").length === 0 ? (
          <p className="text-gray-500 text-sm">No active queries</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-800">
                <th className="py-2 px-2">PID</th>
                <th className="py-2 px-2">Duration</th>
                <th className="py-2 px-2">State</th>
                <th className="py-2 px-2">Wait</th>
                <th className="py-2 px-2">Query</th>
                <th className="py-2 px-2">Client</th>
                <th className="py-2 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {liveActivity
                .filter((a) => a.state !== "idle")
                .map((a) => (
                  <React.Fragment key={a.pid}>
                    <tr
                      className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer"
                      onClick={() => setExpandedPid(expandedPid === a.pid ? null : a.pid)}
                    >
                      <td className="py-1.5 px-2 font-mono">{a.pid}</td>
                      <td className="py-1.5 px-2">{a.duration || "—"}</td>
                      <td className={`py-1.5 px-2 ${stateColor[a.state] || "text-gray-400"}`}>{a.state}</td>
                      <td className="py-1.5 px-2 text-xs">{a.wait_event || "—"}</td>
                      <td className="py-1.5 px-2 font-mono text-xs max-w-md truncate">{a.query}</td>
                      <td className="py-1.5 px-2 text-xs">{a.client_addr || "local"}</td>
                      <td className="py-1.5 px-2">
                        {(a.state === "active" || a.state === "idle in transaction") && (
                          <button
                            className="text-xs text-red-400 hover:text-red-300 cursor-pointer"
                            onClick={(e) => { e.stopPropagation(); cancelQuery(a.pid); }}
                          >Cancel</button>
                        )}
                      </td>
                    </tr>
                    {expandedPid === a.pid && (
                      <tr className="bg-gray-800/50">
                        <td colSpan={7} className="px-4 py-3">
                          <pre className="text-xs font-mono whitespace-pre-wrap text-gray-300">{a.query}</pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Health */}
      {health && (
        <div className="bg-gray-900 rounded-xl p-4 overflow-y-auto max-h-80">
          <h2 className="text-lg font-semibold mb-3">Health Issues ({health.issues.length})</h2>
          {health.issues.length === 0 ? (
            <p className="text-green-400">✅ No issues found!</p>
          ) : (
            <ul className="space-y-3">
              {health.issues.map((issue, i) => (
                <li key={i} className="text-sm">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium mr-2 ${severityBadge[issue.severity]}`}>
                    {issue.severity}
                  </span>
                  <span>{issue.description}</span>
                  {issue.sql && (
                    <div className="mt-1 ml-4 bg-gray-800 rounded px-3 py-1 font-mono text-xs text-gray-300 flex items-center">
                      <code className="flex-1 truncate">{issue.sql}</code>
                      <CopyButton text={issue.sql} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Databases */}
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

      {/* Tables */}
      {sortedTables && (
        <div className="bg-gray-900 rounded-xl p-4 overflow-x-auto">
          <h2 className="text-lg font-semibold mb-3">Tables ({sortedTables.length})</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-800">
                <th className="py-2 px-2">Table</th>
                <th className="py-2 px-2 cursor-pointer" onClick={() => toggleSort("size_bytes")}>
                  Size {sortCol === "size_bytes" && (sortDir === "desc" ? "↓" : "↑")}
                </th>
                <th className="py-2 px-2 cursor-pointer" onClick={() => toggleSort("rows")}>
                  Rows {sortCol === "rows" && (sortDir === "desc" ? "↓" : "↑")}
                </th>
                <th className="py-2 px-2 cursor-pointer" onClick={() => toggleSort("dead_tuples")}>
                  Dead Tuples {sortCol === "dead_tuples" && (sortDir === "desc" ? "↓" : "↑")}
                </th>
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
