import React, { useState } from "react";
import { AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { useFetch } from "../hooks/useApi";
import { formatBytes } from "../utils";

interface DiskUsage {
  dbSize: number;
  dataDir: string;
  tablespaces: { name: string; size: number }[];
  tables: { schema: string; name: string; totalSize: number; tableSize: number; indexSize: number }[];
}

interface DiskPrediction {
  currentBytes: number;
  growthRatePerDay: number;
  predictedFullDate: string | null;
  daysUntilFull: number | null;
  confidence: number;
}

interface HistoryPoint {
  timestamp: number;
  value: number;
}

type RangeKey = "24h" | "7d" | "30d";

export function DiskPage() {
  const [range, setRange] = useState<RangeKey>("24h");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableRange, setTableRange] = useState<RangeKey>("24h");
  const { data: usage, error: usageErr } = useFetch<DiskUsage>("/api/disk/usage", 30000);
  const { data: predictionWrap, error: predErr } = useFetch<{ prediction: DiskPrediction | null }>("/api/disk/prediction?days=30", 60000);
  const { data: history, error: histErr } = useFetch<HistoryPoint[]>(`/api/disk/history?range=${range}`, 30000);

  const { data: tableHistory } = useFetch<HistoryPoint[]>(
    selectedTable ? `/api/disk/table-history/${encodeURIComponent(selectedTable)}?range=${tableRange}` : "",
    30000,
    !selectedTable
  );
  const prediction = predictionWrap?.prediction ?? null;

  const fmtTs = (ts: number) => {
    const d = new Date(ts);
    if (range === "24h") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const rangeBtn = (key: RangeKey) => (
    <button
      className={`text-xs px-2 py-1 rounded cursor-pointer ${range === key ? "bg-blue-800 text-blue-200" : "text-gray-400 hover:text-gray-300"}`}
      onClick={() => setRange(key)}
    >{key}</button>
  );

  const fmtRate = (bytesPerDay: number) => {
    const abs = Math.abs(bytesPerDay);
    const sign = bytesPerDay < 0 ? "-" : "+";
    return `${sign}${formatBytes(abs)}/day`;
  };

  if (usageErr) return (
    <div className="bg-gray-900 rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-2">Disk Usage</h2>
      <div className="bg-red-900/30 border border-red-800 rounded p-3 text-sm text-red-300">{usageErr}</div>
    </div>
  );

  if (!usage) return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => <div key={i} className="h-32 bg-gray-900 rounded-xl animate-pulse" />)}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Top cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* DB Size */}
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="text-xs text-gray-400 mb-1">Database Size</div>
          <div className="text-3xl font-bold">{formatBytes(usage.dbSize)}</div>
          <div className="text-xs text-gray-500 mt-1">{usage.dataDir}</div>
        </div>

        {/* Growth Prediction */}
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="text-xs text-gray-400 mb-1">Growth Prediction (30d)</div>
          {prediction ? (
            <>
              <div className="text-xl font-bold">
                {prediction.daysUntilFull !== null
                  ? `Full in ${Math.round(prediction.daysUntilFull)} days`
                  : "Growth stable"}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Confidence: {(prediction.confidence * 100).toFixed(0)}%
              </div>
            </>
          ) : (
            <div className="text-sm text-gray-500">Not enough data yet</div>
          )}
        </div>

        {/* Growth Rate */}
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="text-xs text-gray-400 mb-1">Growth Rate</div>
          {prediction ? (
            <div className={`text-xl font-bold ${prediction.growthRatePerDay > 0 ? "text-yellow-400" : "text-green-400"}`}>
              {fmtRate(prediction.growthRatePerDay)}
            </div>
          ) : (
            <div className="text-sm text-gray-500">—</div>
          )}
        </div>
      </div>

      {/* History Chart */}
      <div className="bg-gray-900 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Database Size History</h2>
          <div className="flex items-center gap-2">
            {rangeBtn("24h")}
            {rangeBtn("7d")}
            {rangeBtn("30d")}
          </div>
        </div>
        {histErr ? (
          <div className="bg-red-900/30 border border-red-800 rounded p-3 text-sm text-red-300">{histErr}</div>
        ) : !history ? (
          <div className="h-64 bg-gray-800 rounded-lg animate-pulse" />
        ) : history.length === 0 ? (
          <div className="text-gray-500 text-sm text-center py-8">No history data for this range</div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="timestamp" tickFormatter={fmtTs} stroke="#9CA3AF" fontSize={11} />
                <YAxis stroke="#9CA3AF" fontSize={11} tickFormatter={(v) => formatBytes(v)} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: 8 }}
                  labelFormatter={fmtTs}
                  formatter={(value: number) => [formatBytes(value), "DB Size"]}
                />
                <Area type="monotone" dataKey="value" stroke="#60A5FA" fill="#60A5FA" fillOpacity={0.2} name="DB Size" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Per-table breakdown */}
      <div className="bg-gray-900 rounded-xl p-4">
        <h2 className="text-lg font-semibold mb-3">Table Sizes (Top {usage.tables.length})</h2>
        {usage.tables.length === 0 ? (
          <p className="text-gray-500 text-sm">No user tables found.</p>
        ) : (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={usage.tables.slice(0, 15)} layout="vertical" margin={{ left: 100 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis type="number" tickFormatter={(v) => formatBytes(v)} stroke="#9CA3AF" fontSize={11} />
                  <YAxis type="category" dataKey="name" stroke="#9CA3AF" fontSize={11} width={90} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: 8 }}
                    formatter={(value: number, name: string) => [formatBytes(value), name === "tableSize" ? "Data" : "Index"]}
                  />
                  <Legend />
                  <Bar dataKey="tableSize" stackId="a" fill="#60A5FA" name="Data" />
                  <Bar dataKey="indexSize" stackId="a" fill="#34D399" name="Index" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">Table</th>
                    <th className="py-2 px-2 text-right">Total</th>
                    <th className="py-2 px-2 text-right">Data</th>
                    <th className="py-2 px-2 text-right">Index</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.tables.map((t) => {
                    const fullName = `${t.schema}.${t.name}`;
                    return (
                      <tr key={fullName} className={`border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/30 ${selectedTable === fullName ? "bg-gray-800/50" : ""}`} onClick={() => { setSelectedTable(selectedTable === fullName ? null : fullName); setTableRange("24h"); }}>
                        <td className="py-1.5 px-2 font-mono text-xs">{fullName}</td>
                        <td className="py-1.5 px-2 text-right font-mono">{formatBytes(t.totalSize)}</td>
                        <td className="py-1.5 px-2 text-right font-mono">{formatBytes(t.tableSize)}</td>
                        <td className="py-1.5 px-2 text-right font-mono">{formatBytes(t.indexSize)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Table size history */}
      {selectedTable && (
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Size History: <span className="font-mono text-blue-400">{selectedTable}</span></h2>
            <div className="flex items-center gap-2">
              {(["24h", "7d", "30d"] as RangeKey[]).map((k) => (
                <button key={k} className={`text-xs px-2 py-1 rounded cursor-pointer ${tableRange === k ? "bg-blue-800 text-blue-200" : "text-gray-400 hover:text-gray-300"}`} onClick={() => setTableRange(k)}>{k}</button>
              ))}
              <button className="text-xs px-2 py-1 text-gray-400 hover:text-gray-300 cursor-pointer" onClick={() => setSelectedTable(null)}>✕</button>
            </div>
          </div>
          {!tableHistory || tableHistory.length === 0 ? (
            <div className="text-gray-500 text-sm text-center py-8">No history data yet. Table sizes are recorded every ~5 minutes.</div>
          ) : (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={tableHistory}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="timestamp" tickFormatter={fmtTs} stroke="#9CA3AF" fontSize={11} />
                  <YAxis stroke="#9CA3AF" fontSize={11} tickFormatter={(v) => formatBytes(v)} />
                  <Tooltip contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: 8 }} labelFormatter={fmtTs} formatter={(value: number) => [formatBytes(value), "Size"]} />
                  <Line type="monotone" dataKey="value" stroke="#A78BFA" dot={false} name="Size" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Tablespaces */}
      <div className="bg-gray-900 rounded-xl p-4">
        <h2 className="text-lg font-semibold mb-3">Tablespaces</h2>
        {usage.tablespaces.length === 0 ? (
          <p className="text-gray-500 text-sm">No tablespace data available.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {usage.tablespaces.map((ts) => (
              <div key={ts.name} className="bg-gray-800 rounded-lg px-4 py-3">
                <div className="text-sm font-medium">{ts.name}</div>
                <div className="text-lg font-bold mt-1">{formatBytes(ts.size)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
