import type { MetricPoint } from "./types";

export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const sign = bytes < 0 ? "-" : "";
  const abs = Math.abs(bytes);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)} GB`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)} MB`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)} KB`;
  return `${sign}${abs} B`;
}

export function mergeTimeSeries(data: Record<string, MetricPoint[]>, keys: string[]) {
  const map = new Map<number, Record<string, any>>();
  for (const key of keys) {
    for (const pt of data[key] || []) {
      const bucket = Math.round(pt.timestamp / 30000) * 30000;
      if (!map.has(bucket)) map.set(bucket, { time: formatTime(bucket) });
      map.get(bucket)![key] = Math.round(pt.value * 100) / 100;
    }
  }
  return Array.from(map.entries()).sort(([a], [b]) => a - b).map(([, v]) => v);
}
