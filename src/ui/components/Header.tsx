import { useState } from "react";
import type { Overview, AdvisorResult } from "../types";
import { gradeColors } from "../types";
import { Skeleton } from "./Skeleton";

function ExportDropdown() {
  const [open, setOpen] = useState(false);
  const download = (format: string) => {
    window.open(`/api/export?format=${format}`, "_blank");
    setOpen(false);
  };
  return (
    <div className="relative">
      <button className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded cursor-pointer" onClick={() => setOpen(!open)}>📥 Export</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-lg z-50 min-w-[120px]">
            <button className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-700 cursor-pointer" onClick={() => download("json")}>JSON</button>
            <button className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-700 cursor-pointer" onClick={() => download("md")}>Markdown</button>
          </div>
        </>
      )}
    </div>
  );
}

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
        <ExportDropdown />
      </div>
      {overview ? (
        <div className="text-sm text-gray-400 flex flex-wrap gap-x-4">
          <span>PostgreSQL {overview.version}</span>
          <span>Uptime: {typeof overview.uptime === 'object' && overview.uptime !== null
            ? `${(overview.uptime as any).days ?? 0}d ${(overview.uptime as any).hours ?? 0}h ${(overview.uptime as any).minutes ?? 0}m`
            : overview.uptime}</span>
          <span>Size: {overview.dbSize}</span>
        </div>
      ) : (
        <div className="flex gap-4"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-16" /></div>
      )}
    </header>
  );
}
