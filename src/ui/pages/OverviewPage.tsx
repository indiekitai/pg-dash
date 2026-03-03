import { useState } from "react";
import type { Overview, Database, TableRow, MetricPoint, Range } from "../types";
import { RANGES } from "../types";
import { MetricCard } from "../components/MetricCard";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import { formatBytes } from "../utils";

export function OverviewPage({ overview, liveMetrics, sparklines, databases, tables, range, setRange }: {
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
