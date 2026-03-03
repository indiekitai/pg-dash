import React, { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

interface TopQuery {
  queryid: string;
  query: string;
  total_calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  total_rows: number;
}

interface TrendPoint {
  timestamp: number;
  calls: number;
  mean_exec_time: number;
  total_exec_time: number;
  rows: number;
}

type SortKey = "total_time" | "mean_time" | "calls";
type RangeKey = "1h" | "6h" | "24h" | "7d";

export function QueryTrendsPage() {
  const [queries, setQueries] = useState<TopQuery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("total_time");
  const [range, setRange] = useState<RangeKey>("1h");
  const [selectedQuery, setSelectedQuery] = useState<TopQuery | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [trendLoading, setTrendLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/query-stats/top?range=${range}&orderBy=${sortBy}&limit=20`);
        const data = await r.json();
        if (data.error) {
          setError(data.error);
        } else {
          setQueries(data);
          setError(null);
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [range, sortBy]);

  useEffect(() => {
    if (!selectedQuery) return;
    const load = async () => {
      setTrendLoading(true);
      try {
        const r = await fetch(`/api/query-stats/trend/${selectedQuery.queryid}?range=${range}`);
        const data = await r.json();
        setTrend(data);
      } catch {
        setTrend([]);
      } finally {
        setTrendLoading(false);
      }
    };
    load();
  }, [selectedQuery, range]);

  const fmtTime = (ms: number) => {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${ms.toFixed(2)}ms`;
  };

  const fmtTs = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const sortBtn = (key: SortKey, label: string) => (
    <button
      className={`text-xs px-2 py-1 rounded cursor-pointer ${sortBy === key ? "bg-blue-800 text-blue-200" : "text-gray-400 hover:text-gray-300"}`}
      onClick={() => setSortBy(key)}
    >{label}</button>
  );

  const rangeBtn = (key: RangeKey) => (
    <button
      className={`text-xs px-2 py-1 rounded cursor-pointer ${range === key ? "bg-blue-800 text-blue-200" : "text-gray-400 hover:text-gray-300"}`}
      onClick={() => setRange(key)}
    >{key}</button>
  );

  if (loading) return <div className="text-gray-500 text-sm p-4">Loading query trends...</div>;
  if (error) return (
    <div className="bg-gray-900 rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-2">Query Trends</h2>
      <div className="bg-yellow-900/30 border border-yellow-800 rounded p-3 text-sm text-yellow-300">{error}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Trend chart */}
      {selectedQuery && (
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold truncate max-w-2xl font-mono">{selectedQuery.query}</h3>
            <button className="text-xs text-gray-400 hover:text-gray-300 cursor-pointer" onClick={() => setSelectedQuery(null)}>✕ Close</button>
          </div>
          {trendLoading ? (
            <div className="text-gray-500 text-sm">Loading trend...</div>
          ) : trend.length === 0 ? (
            <div className="text-gray-500 text-sm">No trend data available for this range</div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="timestamp" tickFormatter={fmtTs} stroke="#9CA3AF" fontSize={11} />
                  <YAxis yAxisId="time" stroke="#60A5FA" fontSize={11} tickFormatter={(v) => fmtTime(v)} />
                  <YAxis yAxisId="calls" orientation="right" stroke="#34D399" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: 8 }}
                    labelFormatter={fmtTs}
                    formatter={(value: number, name: string) =>
                      name === "mean_exec_time" ? [fmtTime(value), "Avg Time"] : [value.toLocaleString(), "Calls"]
                    }
                  />
                  <Legend />
                  <Line yAxisId="time" type="monotone" dataKey="mean_exec_time" stroke="#60A5FA" name="Avg Time" dot={false} strokeWidth={2} />
                  <Line yAxisId="calls" type="monotone" dataKey="calls" stroke="#34D399" name="Calls" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Top queries table */}
      <div className="bg-gray-900 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-lg font-semibold">Query Trends ({queries.length})</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Range:</span>
            {rangeBtn("1h")}
            {rangeBtn("6h")}
            {rangeBtn("24h")}
            {rangeBtn("7d")}
            <span className="text-xs text-gray-500 ml-2">Sort:</span>
            {sortBtn("total_time", "Total Time")}
            {sortBtn("mean_time", "Avg Time")}
            {sortBtn("calls", "Calls")}
          </div>
        </div>
        {queries.length === 0 ? (
          <p className="text-gray-500 text-sm">No query stats collected yet. Data will appear after the first snapshot interval.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-800">
                  <th className="py-2 px-2">Query</th>
                  <th className="py-2 px-2 text-right">Calls</th>
                  <th className="py-2 px-2 text-right">Total Time</th>
                  <th className="py-2 px-2 text-right">Avg Time</th>
                  <th className="py-2 px-2 text-right">Rows</th>
                </tr>
              </thead>
              <tbody>
                {queries.map((q) => (
                  <tr
                    key={q.queryid}
                    className={`border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer ${selectedQuery?.queryid === q.queryid ? "bg-gray-800/50" : ""}`}
                    onClick={() => setSelectedQuery(q)}
                  >
                    <td className="py-1.5 px-2 font-mono text-xs max-w-lg truncate">{q.query}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{q.total_calls.toLocaleString()}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{fmtTime(q.total_exec_time)}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{fmtTime(q.mean_exec_time)}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{q.total_rows.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
