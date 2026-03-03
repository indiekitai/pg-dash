import React, { useEffect, useState } from "react";
import { ExplainTree } from "./ExplainTree";

interface Props {
  query: string;
  onClose: () => void;
}

export function ExplainModal({ query, onClose }: Props) {
  const [plan, setPlan] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [query]);

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
      </div>
    </div>
  );
}
