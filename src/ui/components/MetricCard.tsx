import { LineChart, Line, ResponsiveContainer } from "recharts";
import type { MetricPoint } from "../types";

export function MetricCard({ label, value, unit, sparkData }: { label: string; value: string | number; unit?: string; sparkData?: MetricPoint[] }) {
  return (
    <div className="bg-gray-900 rounded-xl p-4 flex flex-col">
      <div className="text-xs text-gray-400 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1">
        {value}{unit && <span className="text-sm text-gray-400 ml-1">{unit}</span>}
      </div>
      {sparkData && sparkData.length > 1 && (
        <div className="mt-2 h-10">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparkData}>
              <Line type="monotone" dataKey="value" stroke="#6366f1" dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
