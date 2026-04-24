import { useState } from "react";
import type { SchemaChangeRow, SnapshotRow } from "../types";
import { useFetch } from "../hooks/useApi";
import { useTranslation, localeCode } from "../i18n";

export function SchemaHistoryPanel() {
  const { t, lang } = useTranslation();
  const loc = localeCode(lang);
  const { data: changes, reload } = useFetch<SchemaChangeRow[]>("/api/schema/changes", 60000);
  const { data: snapshots } = useFetch<SnapshotRow[]>("/api/schema/history", 60000);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterObj, setFilterObj] = useState<string>("all");
  const [diffFrom, setDiffFrom] = useState<number>(0);
  const [diffTo, setDiffTo] = useState<number>(0);
  const [diffResult, setDiffResult] = useState<SchemaChangeRow[] | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);

  const loadDiff = async () => {
    if (!diffFrom || !diffTo) return;
    try {
      const r = await fetch(`/api/schema/diff?from=${diffFrom}&to=${diffTo}`);
      setDiffResult(await r.json());
    } catch (e) { console.error(e); }
  };

  const takeSnapshot = async () => {
    setSnapshotting(true);
    try {
      await fetch("/api/schema/snapshot", { method: "POST" });
      reload();
    } catch (e) { console.error(e); }
    setSnapshotting(false);
  };

  const changeIcon: Record<string, string> = { added: "＋", removed: "−", modified: "~" };
  const changeColor: Record<string, string> = { added: "text-green-400", removed: "text-red-400", modified: "text-yellow-400" };
  const changeBg: Record<string, string> = { added: "bg-green-900/20", removed: "bg-red-900/20", modified: "bg-yellow-900/20" };

  const filtered = (changes || []).filter((c) =>
    (filterType === "all" || c.change_type === filterType) &&
    (filterObj === "all" || c.object_type === filterObj)
  );

  const displayChanges = diffResult || filtered;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select className="bg-gray-800 text-sm rounded px-3 py-1.5 border border-gray-700" value={filterType} onChange={(e) => { setFilterType(e.target.value); setDiffResult(null); }}>
          <option value="all">{t("schema.history.filterAllTypes")}</option>
          <option value="added">{t("schema.history.added")}</option>
          <option value="removed">{t("schema.history.removed")}</option>
          <option value="modified">{t("schema.history.modified")}</option>
        </select>
        <select className="bg-gray-800 text-sm rounded px-3 py-1.5 border border-gray-700" value={filterObj} onChange={(e) => { setFilterObj(e.target.value); setDiffResult(null); }}>
          <option value="all">{t("schema.history.filterAllObjects")}</option>
          <option value="table">{t("schema.history.tables")}</option>
          <option value="column">{t("schema.history.columns")}</option>
          <option value="index">{t("schema.history.indexes")}</option>
          <option value="constraint">{t("schema.history.constraints")}</option>
          <option value="enum">{t("schema.history.enums")}</option>
        </select>
        <button className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded cursor-pointer disabled:opacity-50" onClick={takeSnapshot} disabled={snapshotting}>
          {snapshotting ? t("schema.history.takingSnapshot") : t("schema.history.takeSnapshot")}
        </button>
      </div>

      {/* Snapshot Comparison */}
      {snapshots && snapshots.length >= 2 && (
        <div className="bg-gray-900 rounded-xl p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2">{t("schema.history.compareSnapshots")}</h3>
          <div className="flex flex-wrap items-center gap-3">
            <select className="bg-gray-800 text-sm rounded px-3 py-1.5 border border-gray-700" value={diffFrom} onChange={(e) => setDiffFrom(Number(e.target.value))}>
              <option value={0}>{t("schema.history.from")}</option>
              {snapshots.map((s) => <option key={s.id} value={s.id}>#{s.id} — {new Date(s.timestamp).toLocaleString(loc)}</option>)}
            </select>
            <span className="text-gray-500">→</span>
            <select className="bg-gray-800 text-sm rounded px-3 py-1.5 border border-gray-700" value={diffTo} onChange={(e) => setDiffTo(Number(e.target.value))}>
              <option value={0}>{t("schema.history.to")}</option>
              {snapshots.map((s) => <option key={s.id} value={s.id}>#{s.id} — {new Date(s.timestamp).toLocaleString(loc)}</option>)}
            </select>
            <button className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded cursor-pointer" onClick={loadDiff}>{t("schema.history.compare")}</button>
            {diffResult && <button className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded cursor-pointer" onClick={() => setDiffResult(null)}>{t("schema.history.clear")}</button>}
          </div>
        </div>
      )}

      {/* Changes timeline */}
      <div className="bg-gray-900 rounded-xl p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">
          {diffResult ? t("schema.history.diffTitle", { from: diffFrom, to: diffTo }) : t("schema.history.recentChanges")} ({displayChanges.length})
        </h3>
        {displayChanges.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-6">{t("schema.history.noChanges")}</p>
        ) : (
          <div className="space-y-2">
            {displayChanges.map((c, i) => (
              <div key={c.id ?? i} className={`flex items-start gap-3 rounded-lg px-3 py-2 ${changeBg[c.change_type]}`}>
                <span className={`text-lg font-bold ${changeColor[c.change_type]}`}>{changeIcon[c.change_type]}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{c.detail}</div>
                  <div className="flex gap-3 mt-0.5 text-xs text-gray-500">
                    <span className="uppercase">{c.object_type}</span>
                    {c.table_name && <span className="font-mono">{c.table_name}</span>}
                    {c.timestamp && <span>{new Date(c.timestamp).toLocaleString(loc)}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
