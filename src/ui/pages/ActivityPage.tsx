import React, { useState } from "react";
import type { ActivityRow } from "../types";
import { stateColor } from "../types";
import { Toast } from "../components/Toast";
import { ExplainModal } from "../components/ExplainModal";

export function ActivityPage({ activity }: { activity: ActivityRow[] }) {
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [explainQuery, setExplainQuery] = useState<string | null>(null);
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
              <th className="py-2 px-2">PID</th><th className="py-2 px-2">App</th><th className="py-2 px-2">Duration</th><th className="py-2 px-2">State</th><th className="py-2 px-2">Wait</th><th className="py-2 px-2">Query</th><th className="py-2 px-2">Client</th><th className="py-2 px-2"></th>
            </tr></thead>
            <tbody>
              {nonIdle.map((a) => (
                <React.Fragment key={a.pid}>
                  <tr className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer" onClick={() => setExpandedPid(expandedPid === a.pid ? null : a.pid)}>
                    <td className="py-1.5 px-2 font-mono">{a.pid}</td>
                    <td className="py-1.5 px-2 text-xs">{a.application_name || "—"}</td>
                    <td className="py-1.5 px-2">{a.duration || "—"}</td>
                    <td className={`py-1.5 px-2 ${stateColor[a.state] || "text-gray-400"}`}>{a.state}</td>
                    <td className="py-1.5 px-2 text-xs">{a.wait_event || "—"}</td>
                    <td className="py-1.5 px-2 font-mono text-xs max-w-md truncate">{a.query}</td>
                    <td className="py-1.5 px-2 text-xs">{a.client_addr || "local"}</td>
                    <td className="py-1.5 px-2">
                      <span className="flex gap-2">
                        {a.query && (
                          <button className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer" onClick={(e) => { e.stopPropagation(); setExplainQuery(a.query); }}>EXPLAIN</button>
                        )}
                        {(a.state === "active" || a.state === "idle in transaction") && (
                          <button className="text-xs text-red-400 hover:text-red-300 cursor-pointer" onClick={(e) => { e.stopPropagation(); cancelQuery(a.pid); }}>Cancel</button>
                        )}
                      </span>
                    </td>
                  </tr>
                  {expandedPid === a.pid && (
                    <tr className="bg-gray-800/50"><td colSpan={8} className="px-4 py-3"><pre className="text-xs font-mono whitespace-pre-wrap text-gray-300">{a.query}</pre></td></tr>
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
      {explainQuery && <ExplainModal query={explainQuery} onClose={() => setExplainQuery(null)} />}
    </div>
  );
}
