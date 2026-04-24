import { useState } from "react";
import type { SchemaTable, TableDetail } from "../types";
import { useFetch } from "../hooks/useApi";
import { SchemaHistoryPanel } from "../components/SchemaHistoryPanel";
import { useTranslation, localeCode } from "../i18n";

export function SchemaPage() {
  const { t, lang } = useTranslation();
  const loc = localeCode(lang);
  const { data: tables } = useFetch<SchemaTable[]>("/api/schema/tables", 60000);
  const { data: extensions } = useFetch<{ name: string; installed_version: string; schema: string; description: string | null }[]>("/api/schema/extensions", 120000);
  const { data: enums } = useFetch<{ name: string; schema: string; values: string[] }[]>("/api/schema/enums", 120000);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [detailTab, setDetailTab] = useState<"columns" | "indexes" | "constraints" | "fkeys" | "sample">("columns");
  const [search, setSearch] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [schemaView, setSchemaView] = useState<"browser" | "history">("browser");

  const loadDetail = async (name: string) => {
    setSelectedTable(name);
    setLoadingDetail(true);
    setDetailTab("columns");
    try {
      const r = await fetch(`/api/schema/tables/${name}`);
      if (r.ok) setDetail(await r.json());
    } catch (e) { console.error(e); }
    setLoadingDetail(false);
  };

  const filteredTables = tables?.filter((tb) => tb.name.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <div className="space-y-4">
      {/* Schema sub-tabs */}
      <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
        <button className={`px-4 py-2 text-sm rounded-lg cursor-pointer ${schemaView === "browser" ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800"}`} onClick={() => setSchemaView("browser")}>{t("schema.schemaBrowser")}</button>
        <button className={`px-4 py-2 text-sm rounded-lg cursor-pointer ${schemaView === "history" ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800"}`} onClick={() => setSchemaView("history")}>{t("schema.schemaHistory")}</button>
      </div>

      {schemaView === "history" && <SchemaHistoryPanel />}

      {schemaView === "browser" && <div className="flex gap-4 h-[calc(100vh-16rem)]">
      {/* Sidebar */}
      <div className="w-64 flex-shrink-0 bg-gray-900 rounded-xl p-3 overflow-y-auto">
        <input className="w-full bg-gray-800 rounded px-3 py-1.5 text-sm mb-3 border border-gray-700" placeholder={t("schema.searchTables")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="space-y-1">
          {filteredTables.map((tb) => (
            <button
              key={`${tb.schema}.${tb.name}`}
              className={`w-full text-left px-3 py-2 rounded text-sm cursor-pointer ${selectedTable === tb.name ? "bg-indigo-600/30 text-indigo-300" : "hover:bg-gray-800"}`}
              onClick={() => loadDetail(tb.name)}
            >
              <div className="font-mono">{tb.name}</div>
              <div className="text-xs text-gray-500">{tb.total_size} · {Number(tb.row_count).toLocaleString(loc)} {t("schema.rowsSuffix")}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 overflow-y-auto space-y-4">
        {!selectedTable && (
          <div className="space-y-4">
            <div className="bg-gray-900 rounded-xl p-6 text-center text-gray-500">{t("schema.selectTable")}</div>
            {extensions && extensions.length > 0 && (
              <div className="bg-gray-900 rounded-xl p-4">
                <h3 className="text-lg font-semibold mb-3">{t("schema.extensions")} ({extensions.length})</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {extensions.map((e) => (
                    <div key={e.name} className="bg-gray-800 rounded-lg px-3 py-2 text-sm">
                      <div className="font-medium">{e.name} <span className="text-gray-400 text-xs">v{e.installed_version}</span></div>
                      {e.description && <div className="text-xs text-gray-500 mt-0.5">{e.description}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {enums && enums.length > 0 && (
              <div className="bg-gray-900 rounded-xl p-4">
                <h3 className="text-lg font-semibold mb-3">{t("schema.enumTypes")} ({enums.length})</h3>
                <div className="space-y-2">
                  {enums.map((e) => (
                    <div key={e.name} className="bg-gray-800 rounded-lg px-3 py-2 text-sm">
                      <span className="font-mono font-medium">{e.name}</span>
                      <span className="text-gray-400 ml-2">{e.values.join(", ")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {selectedTable && loadingDetail && <div className="bg-gray-900 rounded-xl p-6 text-center text-gray-500">{t("schema.loading")}</div>}

        {selectedTable && detail && !loadingDetail && (
          <>
            {/* Header */}
            <div className="bg-gray-900 rounded-xl p-4">
              <h2 className="text-xl font-bold font-mono">{detail.schema}.{detail.name}</h2>
              <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-400">
                <span>{t("schema.total")} {detail.total_size}</span>
                <span>{t("schema.table")} {detail.table_size}</span>
                <span>{t("schema.indexes")} {detail.index_size}</span>
                <span>{t("schema.toast")} {detail.toast_size || "0 bytes"}</span>
                <span>{t("schema.rows")} {Number(detail.row_count).toLocaleString(loc)}</span>
                <span>{t("schema.dead")} {Number(detail.dead_tuples).toLocaleString(loc)}</span>
                <span>{t("schema.seqScans")} {detail.seq_scan}</span>
                <span>{t("schema.idxScans")} {detail.idx_scan}</span>
              </div>
            </div>

            {/* Detail Tabs */}
            <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
              {(["columns", "indexes", "constraints", "fkeys", "sample"] as const).map((tab) => (
                <button
                  key={tab}
                  className={`px-3 py-1.5 text-sm rounded cursor-pointer ${detailTab === tab ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800"}`}
                  onClick={() => setDetailTab(tab)}
                >{t(`schema.tabs.${tab}`)}</button>
              ))}
            </div>

            <div className="bg-gray-900 rounded-xl p-4 overflow-x-auto">
              {detailTab === "columns" && (
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">{t("schema.cols.name")}</th><th className="py-2 px-2">{t("schema.cols.type")}</th><th className="py-2 px-2">{t("schema.cols.nullable")}</th><th className="py-2 px-2">{t("schema.cols.default")}</th><th className="py-2 px-2">{t("schema.cols.description")}</th>
                  </tr></thead>
                  <tbody>{detail.columns.map((col) => (
                    <tr key={col.name} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 font-mono">{col.name}</td>
                      <td className="py-1.5 px-2 text-indigo-300">{col.type}</td>
                      <td className="py-1.5 px-2">{col.nullable ? "✓" : ""}</td>
                      <td className="py-1.5 px-2 text-xs font-mono text-gray-400">{col.default_value || ""}</td>
                      <td className="py-1.5 px-2 text-xs text-gray-500">{col.description || ""}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {detailTab === "indexes" && (
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">{t("schema.cols.name")}</th><th className="py-2 px-2">{t("schema.cols.type")}</th><th className="py-2 px-2">{t("schema.cols.size")}</th><th className="py-2 px-2">{t("schema.cols.scans")}</th><th className="py-2 px-2">{t("schema.cols.reads")}</th><th className="py-2 px-2">{t("schema.cols.props")}</th>
                  </tr></thead>
                  <tbody>{detail.indexes.map((idx) => (
                    <tr key={idx.name} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 font-mono">{idx.name}</td>
                      <td className="py-1.5 px-2">{idx.type}</td>
                      <td className="py-1.5 px-2">{idx.size}</td>
                      <td className="py-1.5 px-2">{idx.idx_scan?.toLocaleString(loc) ?? "—"}</td>
                      <td className="py-1.5 px-2">{idx.idx_tup_read?.toLocaleString(loc) ?? "—"}</td>
                      <td className="py-1.5 px-2 text-xs">{[idx.is_primary && "PK", idx.is_unique && "UNIQUE"].filter(Boolean).join(", ") || "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {detailTab === "constraints" && (
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">{t("schema.cols.name")}</th><th className="py-2 px-2">{t("schema.cols.type")}</th><th className="py-2 px-2">{t("schema.cols.definition")}</th>
                  </tr></thead>
                  <tbody>{detail.constraints.map((c) => (
                    <tr key={c.name} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 font-mono">{c.name}</td>
                      <td className="py-1.5 px-2">{c.type}</td>
                      <td className="py-1.5 px-2 text-xs font-mono text-gray-400">{c.definition}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {detailTab === "fkeys" && (
                detail.foreignKeys.length === 0 ? <p className="text-gray-500">{t("schema.noForeignKeys")}</p> :
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">{t("schema.cols.name")}</th><th className="py-2 px-2">{t("schema.cols.column")}</th><th className="py-2 px-2">{t("schema.cols.refTable")}</th><th className="py-2 px-2">{t("schema.cols.refColumn")}</th>
                  </tr></thead>
                  <tbody>{detail.foreignKeys.map((fk) => (
                    <tr key={fk.name + fk.column_name} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 font-mono">{fk.name}</td>
                      <td className="py-1.5 px-2">{fk.column_name}</td>
                      <td className="py-1.5 px-2 text-indigo-300 cursor-pointer hover:underline" onClick={() => loadDetail(fk.referenced_table)}>{fk.referenced_table}</td>
                      <td className="py-1.5 px-2">{fk.referenced_column}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {detailTab === "sample" && (
                detail.sampleData.length === 0 ? <p className="text-gray-500">{t("schema.noSampleData")}</p> :
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                      {Object.keys(detail.sampleData[0]).map((k) => <th key={k} className="py-2 px-2 whitespace-nowrap">{k}</th>)}
                    </tr></thead>
                    <tbody>{detail.sampleData.map((row, i) => (
                      <tr key={i} className="border-b border-gray-800/50">
                        {Object.values(row).map((v, j) => <td key={j} className="py-1.5 px-2 text-xs font-mono max-w-xs truncate">{String(v ?? "NULL")}</td>)}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>}
    </div>
  );
}
