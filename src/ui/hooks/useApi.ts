import { useEffect, useState, useCallback } from "react";

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(url, init);
  if (r.status === 401) {
    const token = prompt("pg-dash requires authentication. Enter token:");
    if (token) {
      const authRes = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (authRes.ok) {
        window.location.reload();
      } else {
        alert("Invalid token");
      }
    }
    throw new Error("Unauthorized");
  }
  return r;
}

export function useFetch<T>(url: string, refreshMs = 30000, paused = false): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (paused) return;
    let active = true;
    const load = async () => {
      try {
        const r = await authFetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        if (active) { setData(json); setError(null); }
      } catch (e: any) { if (active) setError(e.message); }
    };
    load();
    const iv = setInterval(load, refreshMs);
    return () => { active = false; clearInterval(iv); };
  }, [url, refreshMs, tick, paused]);
  return { data, error, reload };
}
