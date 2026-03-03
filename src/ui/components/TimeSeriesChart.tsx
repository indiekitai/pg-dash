import { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import type { MetricPoint, Range } from "../types";
import { formatTime, mergeTimeSeries } from "../utils";

export function TimeSeriesChart({ title, metrics, range, colors }: {
  title: string;
  metrics: { key: string; label: string }[];
  range: Range;
  colors: string[];
}) {
  const [data, setData] = useState<Record<string, MetricPoint[]>>({});
  useEffect(() => {
    const load = async () => {
      const result: Record<string, MetricPoint[]> = {};
      await Promise.all(
        metrics.map(async (m) => {
          try { const r = await fetch(`/api/metrics?metric=${m.key}&range=${range}`); result[m.key] = await r.json(); }
          catch { result[m.key] = []; }
        })
      );
      setData(result);
    };
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [range, metrics.map(m => m.key).join(",")]);

  const merged = mergeTimeSeries(data, metrics.map(m => m.key));
  if (merged.length < 2) {
    return (
      <div className="bg-gray-900 rounded-xl p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-2">{title}</h3>
        <div className="h-48 flex items-center justify-center text-gray-600">Collecting data...</div>
      </div>
    );
  }
  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-2">{title}</h3>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={merged}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#9ca3af" }} />
            <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} />
            <Tooltip contentStyle={{ background: "#1f2937", border: "none", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#9ca3af" }} />
            {metrics.map((m, i) => (
              <Area key={m.key} type="monotone" dataKey={m.key} name={m.label} stroke={colors[i]} fill={colors[i]} fillOpacity={0.15} strokeWidth={1.5} dot={false} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
