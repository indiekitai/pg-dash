import React, { useEffect, useState } from "react";

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

interface Table {
  schema: string;
  name: string;
  total_size: string;
  size_bytes: string;
  rows: number;
  dead_tuples: number;
  dead_pct: number;
}

function useFetch<T>(url: string): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        if (active) setData(json);
      } catch (e: any) {
        if (active) setError(e.message);
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => { active = false; clearInterval(interval); };
  }, [url]);

  return { data, error };
}

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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ml-2 px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 rounded cursor-pointer"
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
    >
      {copied ? "✓" : "Copy"}
    </button>
  );
}

export default function App() {
  const { data: overview } = useFetch<Overview>("/api/overview");
  const { data: health } = useFetch<Health>("/api/health");
  const { data: databases } = useFetch<Database[]>("/api/databases");
  const { data: tables } = useFetch<Table[]>("/api/tables");
  const [sortCol, setSortCol] = useState<"size_bytes" | "rows" | "dead_tuples">("size_bytes");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sortedTables = tables?.slice().sort((a, b) => {
    const va = Number(a[sortCol]), vb = Number(b[sortCol]);
    return sortDir === "desc" ? vb - va : va - vb;
  });

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🐘 pg-dash</h1>
        {overview && (
          <div className="text-sm text-gray-400 space-x-4">
            <span>PostgreSQL {overview.version}</span>
            <span>Uptime: {overview.uptime}</span>
            <span>Size: {overview.dbSize}</span>
            <span>Connections: {overview.connections.active}/{overview.connections.max}</span>
          </div>
        )}
      </header>

      {/* Health Score */}
      {health && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className={`border-2 rounded-xl p-6 text-center ${gradeColors[health.grade] || "border-gray-600"}`}>
            <div className="text-6xl font-black">{health.grade}</div>
            <div className="text-sm mt-1 text-gray-400">Health Score: {health.score}/100</div>
          </div>
          <div className="md:col-span-3 bg-gray-900 rounded-xl p-4 overflow-y-auto max-h-80">
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
