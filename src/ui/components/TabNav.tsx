import type { Tab, ActivityRow } from "../types";

export function TabNav({ tab, setTab, tabs, liveActivity, setAlertCount }: {
  tab: Tab;
  setTab: (t: Tab) => void;
  tabs: { id: Tab; label: string; badge?: number }[];
  liveActivity: ActivityRow[];
  setAlertCount: (n: number) => void;
}) {
  return (
    <nav className="flex gap-1 bg-gray-900 rounded-xl p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`px-4 py-2 text-sm rounded-lg cursor-pointer transition-colors ${tab === t.id ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}
          onClick={() => { setTab(t.id); if (t.id === "alerts") setAlertCount(0); }}
        >
          {t.label}
          {t.id === "activity" && liveActivity.filter(a => a.state !== "idle").length > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-green-600 rounded-full">{liveActivity.filter(a => a.state !== "idle").length}</span>
          )}
          {t.badge && t.badge > 0 && t.id !== "activity" && (
            <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-red-600 rounded-full">{t.badge}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
