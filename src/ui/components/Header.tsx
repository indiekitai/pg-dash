import type { Overview, AdvisorResult } from "../types";
import { gradeColors } from "../types";
import { Skeleton } from "./Skeleton";

export function Header({ overview, health, connected }: { overview: Overview | null; health: AdvisorResult | null; connected: boolean }) {
  return (
    <header className="flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">🐘 pg-dash</h1>
        {health && (
          <span className={`text-xl font-black border-2 rounded-lg px-2 py-0.5 ${gradeColors[health.grade] || "border-gray-600"}`}>
            {health.grade}
          </span>
        )}
        <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} title={connected ? "Live" : "Disconnected"} />
      </div>
      {overview ? (
        <div className="text-sm text-gray-400 flex flex-wrap gap-x-4">
          <span>PostgreSQL {overview.version}</span>
          <span>Uptime: {overview.uptime}</span>
          <span>Size: {overview.dbSize}</span>
        </div>
      ) : (
        <div className="flex gap-4"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-16" /></div>
      )}
    </header>
  );
}
