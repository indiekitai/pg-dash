import React, { useEffect, useState } from "react";
import { ExplainModal } from "../components/ExplainModal";

interface SlowQuery {
  queryid: string;
  query: string;
  calls: number;
  total_time: number;
  mean_time: number;
  rows: number;
  total_time_pretty: string;
  mean_time_pretty: string;
}

type SortKey = "total_time" | "mean_time" | "calls";

export function QueriesPage() {
  const [queries, setQueries] = useState<SlowQuery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("total_time");
  const [search, setSearch] = useState("");
  const [explainQuery, setExplainQuery] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/queries");
        const data = await r.json();
        if (Array.isArray(data)) {
          setQueries(data);
        } else {
          setError("pg_stat_statements extension is not installed. Enable it to see query statistics.");
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const filtered = queries
    .filter((q) => !search || q.query.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b[sortBy] as number) - (a[sortBy] as number));

  if (loading) return <div className="text-gray-500 text-sm p-4">Loading queries...</div>;
  if (error) return (
    <div className="bg-gray-900 rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-2">Queries</h2>
      <div className="bg-yellow-900/30 border border-yellow-800 rounded p-3 text-sm text-yellow-300">{error}</div>
    </div>
  );

  const sortBtn = (key: SortKey, label: string) => (
    <button
      className={`text-xs px-2 py-1 rounded cursor-pointer ${sortBy === key ? "bg-blue-800 text-blue-200" : "text-gray-400 hover:text-gray-300"}`}
      onClick={() => setSortBy(key)}
    >{label}</button>
  );

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-lg font-semibold">Slow Queries ({filtered.length})</h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search queries..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300 w-48"
            />
            <span className="text-xs text-gray-500">Sort:</span>
            {sortBtn("total_time", "Total Time")}
            {sortBtn("mean_time", "Avg Time")}
            {sortBtn("calls", "Calls")}
          </div>
        </div>
        {filtered.length === 0 ? (
          <p className="text-gray-500 text-sm">No queries found</p>
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
                  <th className="py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((q) => (
                  <tr key={q.queryid} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-1.5 px-2 font-mono text-xs max-w-lg truncate">{q.query}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{q.calls.toLocaleString()}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{q.total_time_pretty}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{q.mean_time_pretty}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{q.rows.toLocaleString()}</td>
                    <td className="py-1.5 px-2">
                      <button
                        className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                        onClick={() => setExplainQuery(q.query)}
                      >EXPLAIN</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {explainQuery && <ExplainModal query={explainQuery} onClose={() => setExplainQuery(null)} />}
    </div>
  );
}
