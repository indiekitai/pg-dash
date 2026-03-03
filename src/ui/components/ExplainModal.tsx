import React, { useEffect, useState } from "react";
import { ExplainTree } from "./ExplainTree";

interface IndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  sql: string;
  estimatedBenefit: "high" | "medium" | "low";
}

interface ExplainAnalysis {
  seqScans: { table: string; rowCount: number; filter?: string }[];
  missingIndexes: IndexSuggestion[];
  recommendations: string[];
  costEstimate: { totalCost: number; actualTime?: number; planningTime?: number };
}

interface Props {
  query: string;
  onClose: () => void;
}

const benefitColor: Record<string, string> = {
  high: "text-red-400",
  medium: "text-yellow-400",
  low: "text-blue-400",
};

export function ExplainModal({ query, onClose }: Props) {
  const [plan, setPlan] = useState<any[] | null>(null);
  const [analysis, setAnalysis] = useState<ExplainAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        const r = await fetch("/api/explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        const data = await r.json();
        if (data.error) {
          setError(data.error);
        } else {
          setPlan(data.plan);
          if (data.analysis) setAnalysis(data.analysis);
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [query]);

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // fallback — ignore
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 rounded-xl p-5 max-w-4xl w-full max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">EXPLAIN Plan</h3>
          <button className="text-gray-400 hover:text-white text-xl cursor-pointer" onClick={onClose}>×</button>
        </div>
        <div className="mb-3 bg-gray-950 rounded p-2">
          <pre className="text-xs font-mono text-gray-400 whitespace-pre-wrap max-h-24 overflow-auto">{query}</pre>
        </div>
        {loading && <p className="text-gray-500 text-sm">Running EXPLAIN ANALYZE...</p>}
        {error && <div className="bg-red-900/30 border border-red-800 rounded p-3 text-sm text-red-300">{error}</div>}
        {plan && <ExplainTree plan={plan} />}

        {/* ── Index Suggestions ── */}
        {analysis && analysis.missingIndexes.length > 0 && (
          <div className="mt-4 border border-yellow-700/40 rounded-lg p-4 bg-yellow-900/10">
            <h4 className="text-sm font-semibold text-yellow-400 mb-3">
              💡 Index Suggestions ({analysis.missingIndexes.length})
            </h4>
            <div className="space-y-3">
              {analysis.missingIndexes.map((idx, i) => (
                <div key={i} className="bg-gray-950 rounded p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400 mb-1">
                        {idx.reason}
                        <span className={`ml-2 font-semibold ${benefitColor[idx.estimatedBenefit] ?? "text-gray-400"}`}>
                          [{idx.estimatedBenefit} impact]
                        </span>
                      </p>
                      <pre className="text-xs font-mono text-green-300 whitespace-pre-wrap break-all">{idx.sql}</pre>
                    </div>
                    <button
                      className="shrink-0 text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer"
                      onClick={() => copyToClipboard(idx.sql, `idx-${i}`)}
                    >
                      {copied === `idx-${i}` ? "✓ Copied" : "Copy SQL"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Recommendations ── */}
        {analysis && analysis.recommendations.length > 0 && (
          <div className="mt-3 border border-gray-700/40 rounded-lg p-3 bg-gray-800/30">
            <h4 className="text-xs font-semibold text-gray-400 mb-2">📋 Recommendations</h4>
            <ul className="space-y-1">
              {analysis.recommendations.map((rec, i) => (
                <li key={i} className="text-xs text-gray-300">• {rec}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
