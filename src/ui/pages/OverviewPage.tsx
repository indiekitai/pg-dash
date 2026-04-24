import { useState } from "react";
import type { Overview, Database, TableRow, MetricPoint, Range } from "../types";
import { RANGES } from "../types";
import { MetricCard } from "../components/MetricCard";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import { formatBytes } from "../utils";
import { useTranslation, localeCode } from "../i18n";

export function OverviewPage({ overview, liveMetrics, sparklines, databases, tables, range, setRange }: {
  overview: Overview | null; liveMetrics: Record<string, number>; sparklines: Record<string, MetricPoint[]>;
  databases: Database[] | null; tables: TableRow[] | null; range: Range; setRange: (r: Range) => void;
}) {
  const { t, lang } = useTranslation();
  const loc = localeCode(lang);
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
        <MetricCard label={t("overview.activeConnections")} value={liveMetrics.connections_active ?? overview?.connections.active ?? "—"} unit={overview ? `/ ${overview.connections.max}` : undefined} sparkData={sparklines.connections_active} />
        <MetricCard label={t("overview.tpsCommit")} value={liveMetrics.tps_commit !== undefined ? liveMetrics.tps_commit.toFixed(1) : "—"} unit={t("overview.tpsUnit")} sparkData={sparklines.tps_commit} />
        <MetricCard label={t("overview.cacheHitRatio")} value={liveMetrics.cache_hit_ratio !== undefined ? (liveMetrics.cache_hit_ratio * 100).toFixed(2) : "—"} unit="%" sparkData={sparklines.cache_hit_ratio} />
        <MetricCard label={t("overview.dbSize")} value={liveMetrics.db_size_bytes !== undefined ? formatBytes(liveMetrics.db_size_bytes) : overview?.dbSize ?? "—"} sparkData={sparklines.db_size_bytes} />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm text-gray-400">{t("overview.rangeLabel")}</span>
          {RANGES.map((r) => (
            <button key={r} className={`px-2 py-1 text-xs rounded cursor-pointer ${range === r ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TimeSeriesChart title={t("overview.charts.connections")} metrics={[{ key: "connections_active", label: t("overview.charts.active") }, { key: "connections_idle", label: t("overview.charts.idle") }]} range={range} colors={["#22c55e", "#6366f1"]} />
          <TimeSeriesChart title={t("overview.charts.tps")} metrics={[{ key: "tps_commit", label: t("overview.charts.commit") }, { key: "tps_rollback", label: t("overview.charts.rollback") }]} range={range} colors={["#22c55e", "#ef4444"]} />
          <TimeSeriesChart title={t("overview.charts.cacheHit")} metrics={[{ key: "cache_hit_ratio", label: t("overview.charts.ratio") }]} range={range} colors={["#f59e0b"]} />
          <TimeSeriesChart title={t("overview.charts.tupleOps")} metrics={[{ key: "tuple_inserted", label: t("overview.charts.insert") }, { key: "tuple_updated", label: t("overview.charts.update") }, { key: "tuple_deleted", label: t("overview.charts.delete") }]} range={range} colors={["#22c55e", "#3b82f6", "#ef4444"]} />
        </div>
      </div>

      {databases && (
        <div className="bg-gray-900 rounded-xl p-4">
          <h2 className="text-lg font-semibold mb-3">{t("overview.databases")} ({databases.length})</h2>
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
          <h2 className="text-lg font-semibold mb-3">{t("overview.tables")} ({sortedTables.length})</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-800">
                <th className="py-2 px-2">{t("overview.tableCol")}</th>
                <th className="py-2 px-2 cursor-pointer" onClick={() => toggleSort("size_bytes")}>{t("overview.sizeCol")} {sortCol === "size_bytes" && (sortDir === "desc" ? "↓" : "↑")}</th>
                <th className="py-2 px-2 cursor-pointer" onClick={() => toggleSort("rows")}>{t("overview.rowsCol")} {sortCol === "rows" && (sortDir === "desc" ? "↓" : "↑")}</th>
                <th className="py-2 px-2 cursor-pointer" onClick={() => toggleSort("dead_tuples")}>{t("overview.deadTuplesCol")} {sortCol === "dead_tuples" && (sortDir === "desc" ? "↓" : "↑")}</th>
                <th className="py-2 px-2">{t("overview.bloatCol")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedTables.map((tr) => (
                <tr key={`${tr.schema}.${tr.name}`} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="py-1.5 px-2 font-mono">{tr.schema}.{tr.name}</td>
                  <td className="py-1.5 px-2">{tr.total_size}</td>
                  <td className="py-1.5 px-2">{Number(tr.rows).toLocaleString(loc)}</td>
                  <td className="py-1.5 px-2">{Number(tr.dead_tuples).toLocaleString(loc)}</td>
                  <td className="py-1.5 px-2">{tr.dead_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
