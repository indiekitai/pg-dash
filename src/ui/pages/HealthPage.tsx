import { useState } from "react";
import type { AdvisorResult } from "../types";
import { gradeColors, severityBadge, categoryColors, effortBadge } from "../types";
import { useFetch } from "../hooks/useApi";
import { GradeCircle } from "../components/GradeCircle";
import { Toast } from "../components/Toast";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 rounded cursor-pointer"
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
    >{copied ? "✓ Copied" : "Copy SQL"}</button>
  );
}

export function HealthPage() {
  const { data: advisor, reload } = useFetch<AdvisorResult>("/api/advisor", 120000);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [fixModal, setFixModal] = useState<{ sql: string; title: string } | null>(null);
  const [executing, setExecuting] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [showMuted, setShowMuted] = useState(false);
  const [mutedIds, setMutedIds] = useState<string[]>([]);

  const muteIssue = async (issueId: string) => {
    try {
      await fetch("/api/advisor/ignore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueId }) });
      setToast({ message: "Issue muted", type: "success" });
      reload();
    } catch (e: any) { setToast({ message: `Error: ${e.message}`, type: "error" }); }
  };

  const unmuteIssue = async (issueId: string) => {
    try {
      await fetch(`/api/advisor/ignore/${encodeURIComponent(issueId)}`, { method: "DELETE" });
      setMutedIds(mutedIds.filter(id => id !== issueId));
      setToast({ message: "Issue unmuted", type: "success" });
      reload();
    } catch (e: any) { setToast({ message: `Error: ${e.message}`, type: "error" }); }
  };

  const loadMuted = async () => {
    try {
      const r = await fetch("/api/advisor/ignored");
      if (r.ok) setMutedIds(await r.json());
    } catch {}
    setShowMuted(!showMuted);
  };

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
        <GradeCircle grade={advisor.grade} score={advisor.score} />
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
        {(advisor.ignoredCount ?? 0) > 0 && (
          <button className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded cursor-pointer" onClick={loadMuted}>
            🔇 {advisor.ignoredCount} muted
          </button>
        )}
        <button className="ml-auto px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded cursor-pointer" onClick={reload}>↻ Re-scan</button>
      </div>

      {/* Skipped checks */}
      {advisor.skipped && advisor.skipped.length > 0 && (
        <div className="bg-gray-900 rounded-xl p-4">
          <button className="text-sm text-yellow-400 cursor-pointer" onClick={() => setShowSkipped(!showSkipped)}>
            ⚠️ {advisor.skipped.length} check{advisor.skipped.length !== 1 ? "s" : ""} skipped {showSkipped ? "▲" : "▼"}
          </button>
          {showSkipped && (
            <ul className="mt-2 space-y-1 text-xs text-gray-400">
              {advisor.skipped.map((s, i) => <li key={i} className="font-mono">• {s}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Muted issues */}
      {showMuted && mutedIds.length > 0 && (
        <div className="bg-gray-900 rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-2">🔇 Muted Issues</h3>
          <ul className="space-y-1">
            {mutedIds.map((id) => (
              <li key={id} className="flex items-center justify-between text-sm">
                <span className="font-mono text-gray-400 truncate">{id}</span>
                <button className="text-xs text-red-400 hover:text-red-300 cursor-pointer ml-2" onClick={() => unmuteIssue(id)}>Unmute</button>
              </li>
            ))}
          </ul>
        </div>
      )}

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
                    <button
                      className="px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 rounded cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); muteIssue(issue.id); }}
                    >🔇 Mute</button>
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
