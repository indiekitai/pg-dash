import { useEffect, useState, useCallback } from "react";

export function useFetch<T>(url: string, refreshMs = 30000): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        if (active) { setData(json); setError(null); }
      } catch (e: any) { if (active) setError(e.message); }
    };
    load();
    const iv = setInterval(load, refreshMs);
    return () => { active = false; clearInterval(iv); };
  }, [url, refreshMs, tick]);
  return { data, error, reload };
}
