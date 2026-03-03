import type { MetricPoint } from "./types";

export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatBytes(bytes: number) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
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
