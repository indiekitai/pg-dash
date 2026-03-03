import { useState } from "react";
import type { AlertRuleRow, AlertHistoryRow } from "../types";
import { severityBadge, ALERT_METRICS } from "../types";
import { useFetch } from "../hooks/useApi";
import { Toast } from "../components/Toast";

export function AlertsPage() {
  const { data: rules, reload: reloadRules } = useFetch<AlertRuleRow[]>("/api/alerts/rules", 30000);
  const { data: history, reload: reloadHistory } = useFetch<AlertHistoryRow[]>("/api/alerts/history?limit=50", 15000);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRuleRow | null>(null);
  const [form, setForm] = useState({ name: "", metric: "connection_util", operator: "gt", threshold: "80", severity: "warning", cooldown_minutes: "60" });

  const resetForm = () => {
    setForm({ name: "", metric: "connection_util", operator: "gt", threshold: "80", severity: "warning", cooldown_minutes: "60" });
    setEditingRule(null);
    setShowForm(false);
  };

  const saveRule = async () => {
    const body = {
      name: form.name,
      metric: form.metric,
      operator: form.operator,
      threshold: parseFloat(form.threshold),
      severity: form.severity,
      enabled: 1,
      cooldown_minutes: parseInt(form.cooldown_minutes),
    };
    try {
      if (editingRule) {
        await fetch(`/api/alerts/rules/${editingRule.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        setToast({ message: "Rule updated", type: "success" });
      } else {
        await fetch("/api/alerts/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        setToast({ message: "Rule created", type: "success" });
      }
      resetForm();
      reloadRules();
    } catch (e: any) {
      setToast({ message: e.message, type: "error" });
    }
  };

  const toggleRule = async (rule: AlertRuleRow) => {
    await fetch(`/api/alerts/rules/${rule.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: rule.enabled ? 0 : 1 }) });
    reloadRules();
  };

  const deleteRule = async (id: number) => {
    if (!confirm("Delete this rule?")) return;
    await fetch(`/api/alerts/rules/${id}`, { method: "DELETE" });
    reloadRules();
  };

  const startEdit = (rule: AlertRuleRow) => {
    setEditingRule(rule);
    setForm({ name: rule.name, metric: rule.metric, operator: rule.operator, threshold: String(rule.threshold), severity: rule.severity, cooldown_minutes: String(rule.cooldown_minutes) });
    setShowForm(true);
  };

  return (
    <div className="space-y-6">
      {/* Rules */}
      <div className="bg-gray-900 rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Alert Rules</h2>
          <button className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded cursor-pointer" onClick={() => { resetForm(); setShowForm(!showForm); }}>
            {showForm ? "Cancel" : "+ Add Rule"}
          </button>
        </div>

        {showForm && (
          <div className="bg-gray-800 rounded-lg p-4 mb-4 space-y-3">
            <input className="w-full bg-gray-700 rounded px-3 py-1.5 text-sm border border-gray-600" placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <select className="bg-gray-700 text-sm rounded px-3 py-1.5 border border-gray-600" value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })}>
                {ALERT_METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <select className="bg-gray-700 text-sm rounded px-3 py-1.5 border border-gray-600" value={form.operator} onChange={(e) => setForm({ ...form, operator: e.target.value })}>
                <option value="gt">Greater than</option>
                <option value="lt">Less than</option>
                <option value="eq">Equal to</option>
              </select>
              <input className="bg-gray-700 text-sm rounded px-3 py-1.5 border border-gray-600" type="number" placeholder="Threshold" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
              <select className="bg-gray-700 text-sm rounded px-3 py-1.5 border border-gray-600" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-400">Cooldown (min):</label>
              <input className="bg-gray-700 text-sm rounded px-3 py-1.5 border border-gray-600 w-24" type="number" value={form.cooldown_minutes} onChange={(e) => setForm({ ...form, cooldown_minutes: e.target.value })} />
              <button className="ml-auto px-4 py-1.5 text-sm bg-green-700 hover:bg-green-600 rounded cursor-pointer" onClick={saveRule}>{editingRule ? "Update" : "Create"}</button>
            </div>
          </div>
        )}

        {!rules ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-12 bg-gray-800 rounded-lg animate-pulse" />)}</div>
        ) : rules.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">No alert rules configured.</p>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div key={rule.id} className={`flex items-center gap-3 bg-gray-800 rounded-lg px-4 py-3 ${!rule.enabled ? "opacity-50" : ""}`}>
                <button className={`w-10 h-5 rounded-full relative cursor-pointer transition-colors ${rule.enabled ? "bg-green-600" : "bg-gray-600"}`} onClick={() => toggleRule(rule)}>
                  <span className={`absolute w-4 h-4 bg-white rounded-full top-0.5 transition-transform ${rule.enabled ? "left-5" : "left-0.5"}`} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{rule.name}</div>
                  <div className="text-xs text-gray-400">{rule.metric} {rule.operator} {rule.threshold} · Cooldown: {rule.cooldown_minutes}min</div>
                </div>
                <span className={`px-2 py-0.5 rounded text-xs ${severityBadge[rule.severity] || "bg-gray-700"}`}>{rule.severity}</span>
                <button className="text-xs text-gray-400 hover:text-white cursor-pointer" onClick={() => startEdit(rule)}>Edit</button>
                <button className="text-xs text-red-400 hover:text-red-300 cursor-pointer" onClick={() => deleteRule(rule.id)}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* History */}
      <div className="bg-gray-900 rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Alert History</h2>
          <button className="text-sm text-gray-400 hover:text-white cursor-pointer" onClick={reloadHistory}>↻ Refresh</button>
        </div>
        {!history ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 bg-gray-800 rounded-lg animate-pulse" />)}</div>
        ) : history.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">No alerts fired yet.</p>
        ) : (
          <div className="space-y-2">
            {history.map((alert) => (
              <div key={alert.id} className="flex items-start gap-3 bg-gray-800 rounded-lg px-4 py-2">
                <span className="text-sm mt-0.5">{alert.message.includes("critical") ? "🔴" : alert.message.includes("warning") ? "🟡" : "🔵"}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{alert.message}</div>
                  <div className="text-xs text-gray-500">{new Date(alert.timestamp).toLocaleString()} · Value: {alert.value}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
