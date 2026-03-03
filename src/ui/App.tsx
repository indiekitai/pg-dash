import { useEffect, useState } from "react";
import type { Overview, Database, TableRow, MetricPoint, AdvisorResult, Range, Tab } from "./types";
import { useFetch } from "./hooks/useApi";
import { useWebSocket } from "./hooks/useWebSocket";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Header } from "./components/Header";
import { TabNav } from "./components/TabNav";
import { Toast } from "./components/Toast";
import { OverviewPage } from "./pages/OverviewPage";
import { HealthPage } from "./pages/HealthPage";
import { SchemaPage } from "./pages/SchemaPage";
import { ActivityPage } from "./pages/ActivityPage";
import { AlertsPage } from "./pages/AlertsPage";
import { QueriesPage } from "./pages/QueriesPage";
import { QueryTrendsPage } from "./pages/QueryTrendsPage";
import { DiskPage } from "./pages/DiskPage";

function getInitialTab(): Tab {
  const hash = window.location.hash.replace("#", "") as Tab;
  if (["overview", "health", "schema", "activity", "queries", "trends", "alerts", "disk"].includes(hash)) return hash;
  return "overview";
}

export default function App() {
  const [range, setRange] = useState<Range>("1h");
  const [tab, setTab] = useState<Tab>(getInitialTab);
  const [alertCount, setAlertCount] = useState(0);

  const { data: overview } = useFetch<Overview>("/api/overview", 30000, tab !== "overview");
  const { data: health } = useFetch<AdvisorResult>("/api/advisor", 60000, tab !== "health");
  const { data: databases } = useFetch<Database[]>("/api/databases", 60000, tab !== "overview");
  const { data: tables } = useFetch<TableRow[]>("/api/tables", 60000, tab !== "overview");
  const { metrics: liveMetrics, activity: liveActivity, alerts: liveAlerts, connected } = useWebSocket();
  const [alertToast, setAlertToast] = useState<string | null>(null);

  // Show toast for new WebSocket alerts
  useEffect(() => {
    if (liveAlerts.length > 0) {
      const latest = liveAlerts[0];
      setAlertToast(latest.message);
      setAlertCount(prev => prev + 1);
      const t = setTimeout(() => setAlertToast(null), 5000);
      return () => clearTimeout(t);
    }
  }, [liveAlerts.length]);

  // Sync tab to URL hash
  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  // Listen for hash changes (back/forward)
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace("#", "") as Tab;
      if (["overview", "health", "schema", "activity", "queries", "trends", "alerts", "disk"].includes(hash)) setTab(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Track unread alert count
  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/alerts/history?limit=10");
        const data = await r.json();
        const oneHourAgo = Date.now() - 3600000;
        const recent = data.filter((a: any) => a.timestamp > oneHourAgo);
        setAlertCount(recent.length);
      } catch (e) { console.error(e); }
    };
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  const [sparklines, setSparklines] = useState<Record<string, MetricPoint[]>>({});
  useEffect(() => {
    if (tab !== "overview") return;
    const load = async () => {
      const keys = ["connections_active", "tps_commit", "cache_hit_ratio", "db_size_bytes"];
      const result: Record<string, MetricPoint[]> = {};
      await Promise.all(keys.map(async (k) => {
        try { const r = await fetch(`/api/metrics?metric=${k}&range=15m`); result[k] = await r.json(); }
        catch { result[k] = []; }
      }));
      setSparklines(result);
    };
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [tab]);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "health", label: "Health" },
    { id: "schema", label: "Schema" },
    { id: "activity", label: "Activity" },
    { id: "queries", label: "Queries" },
    { id: "trends", label: "Trends" },
    { id: "disk", label: "💾 Disk" },
    { id: "alerts", label: "🔔 Alerts", badge: alertCount },
  ];

  return (
    <ErrorBoundary>
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        <Header overview={overview} health={health} connected={connected} />
        <TabNav tab={tab} setTab={setTab} tabs={tabs} liveActivity={liveActivity} setAlertCount={setAlertCount} />

        {tab === "overview" && <OverviewPage overview={overview} liveMetrics={liveMetrics} sparklines={sparklines} databases={databases} tables={tables} range={range} setRange={setRange} />}
        {tab === "health" && <HealthPage />}
        {tab === "schema" && <SchemaPage />}
        {tab === "activity" && <ActivityPage activity={liveActivity} />}
        {tab === "queries" && <QueriesPage />}
        {tab === "trends" && <QueryTrendsPage />}
        {tab === "disk" && <DiskPage />}
        {tab === "alerts" && <AlertsPage />}

        {alertToast && <Toast message={`🔔 ${alertToast}`} type="error" onClose={() => setAlertToast(null)} />}
      </div>
    </ErrorBoundary>
  );
}
