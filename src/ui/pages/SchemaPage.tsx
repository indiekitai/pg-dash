import { useState } from "react";
import type { SchemaTable, TableDetail } from "../types";
import { useFetch } from "../hooks/useApi";
import { SchemaHistoryPanel } from "../components/SchemaHistoryPanel";

export function SchemaPage() {
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

  const filteredTables = tables?.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <div className="space-y-4">
      {/* Schema sub-tabs */}
      <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
        <button className={`px-4 py-2 text-sm rounded-lg cursor-pointer ${schemaView === "browser" ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800"}`} onClick={() => setSchemaView("browser")}>Schema Browser</button>
        <button className={`px-4 py-2 text-sm rounded-lg cursor-pointer ${schemaView === "history" ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800"}`} onClick={() => setSchemaView("history")}>Schema History</button>
      </div>

      {schemaView === "history" && <SchemaHistoryPanel />}

      {schemaView === "browser" && <div className="flex gap-4 h-[calc(100vh-16rem)]">
      {/* Sidebar */}
      <div className="w-64 flex-shrink-0 bg-gray-900 rounded-xl p-3 overflow-y-auto">
        <input className="w-full bg-gray-800 rounded px-3 py-1.5 text-sm mb-3 border border-gray-700" placeholder="Search tables..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="space-y-1">
          {filteredTables.map((t) => (
            <button
              key={`${t.schema}.${t.name}`}
              className={`w-full text-left px-3 py-2 rounded text-sm cursor-pointer ${selectedTable === t.name ? "bg-indigo-600/30 text-indigo-300" : "hover:bg-gray-800"}`}
              onClick={() => loadDetail(t.name)}
            >
              <div className="font-mono">{t.name}</div>
              <div className="text-xs text-gray-500">{t.total_size} · {Number(t.row_count).toLocaleString()} rows</div>
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 overflow-y-auto space-y-4">
        {!selectedTable && (
          <div className="space-y-4">
            <div className="bg-gray-900 rounded-xl p-6 text-center text-gray-500">Select a table from the sidebar</div>
            {extensions && extensions.length > 0 && (
              <div className="bg-gray-900 rounded-xl p-4">
                <h3 className="text-lg font-semibold mb-3">Extensions ({extensions.length})</h3>
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
                <h3 className="text-lg font-semibold mb-3">Enum Types ({enums.length})</h3>
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

        {selectedTable && loadingDetail && <div className="bg-gray-900 rounded-xl p-6 text-center text-gray-500">Loading...</div>}

        {selectedTable && detail && !loadingDetail && (
          <>
            {/* Header */}
            <div className="bg-gray-900 rounded-xl p-4">
              <h2 className="text-xl font-bold font-mono">{detail.schema}.{detail.name}</h2>
              <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-400">
                <span>Total: {detail.total_size}</span>
                <span>Table: {detail.table_size}</span>
                <span>Indexes: {detail.index_size}</span>
                <span>Toast: {detail.toast_size || "0 bytes"}</span>
                <span>Rows: {Number(detail.row_count).toLocaleString()}</span>
                <span>Dead: {Number(detail.dead_tuples).toLocaleString()}</span>
                <span>Seq scans: {detail.seq_scan}</span>
                <span>Idx scans: {detail.idx_scan}</span>
              </div>
            </div>

            {/* Detail Tabs */}
            <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
              {(["columns", "indexes", "constraints", "fkeys", "sample"] as const).map((tab) => (
                <button
                  key={tab}
                  className={`px-3 py-1.5 text-sm rounded cursor-pointer ${detailTab === tab ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800"}`}
                  onClick={() => setDetailTab(tab)}
                >{tab === "fkeys" ? "Foreign Keys" : tab.charAt(0).toUpperCase() + tab.slice(1)}</button>
              ))}
            </div>

            <div className="bg-gray-900 rounded-xl p-4 overflow-x-auto">
              {detailTab === "columns" && (
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">Name</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Nullable</th><th className="py-2 px-2">Default</th><th className="py-2 px-2">Description</th>
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
                    <th className="py-2 px-2">Name</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Size</th><th className="py-2 px-2">Scans</th><th className="py-2 px-2">Reads</th><th className="py-2 px-2">Props</th>
                  </tr></thead>
                  <tbody>{detail.indexes.map((idx) => (
                    <tr key={idx.name} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 font-mono">{idx.name}</td>
                      <td className="py-1.5 px-2">{idx.type}</td>
                      <td className="py-1.5 px-2">{idx.size}</td>
                      <td className="py-1.5 px-2">{idx.idx_scan?.toLocaleString() ?? "—"}</td>
                      <td className="py-1.5 px-2">{idx.idx_tup_read?.toLocaleString() ?? "—"}</td>
                      <td className="py-1.5 px-2 text-xs">{[idx.is_primary && "PK", idx.is_unique && "UNIQUE"].filter(Boolean).join(", ") || "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {detailTab === "constraints" && (
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">Name</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Definition</th>
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
                detail.foreignKeys.length === 0 ? <p className="text-gray-500">No foreign keys</p> :
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-2 px-2">Name</th><th className="py-2 px-2">Column</th><th className="py-2 px-2">→ Table</th><th className="py-2 px-2">→ Column</th>
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
                detail.sampleData.length === 0 ? <p className="text-gray-500">No data</p> :
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
