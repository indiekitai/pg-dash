export interface Overview {
  version: string;
  uptime: string;
  dbSize: string;
  databaseCount: number;
  connections: { active: number; idle: number; max: number };
}

export interface Database {
  name: string;
  size: string;
  size_bytes: string;
}

export interface TableRow {
  schema: string;
  name: string;
  total_size: string;
  size_bytes: string;
  rows: number;
  dead_tuples: number;
  dead_pct: number;
}

export interface ActivityRow {
  pid: number;
  query: string;
  state: string;
  wait_event: string | null;
  wait_event_type: string | null;
  duration: string | null;
  client_addr: string | null;
  application_name: string;
}

export interface MetricPoint {
  timestamp: number;
  value: number;
}

export interface AdvisorIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  category: "performance" | "maintenance" | "schema" | "security";
  title: string;
  description: string;
  fix: string;
  impact: string;
  effort: "quick" | "moderate" | "involved";
}

export interface AdvisorResult {
  score: number;
  grade: string;
  issues: AdvisorIssue[];
  breakdown: Record<string, { score: number; grade: string; count: number }>;
}

export interface SchemaTable {
  name: string;
  schema: string;
  total_size: string;
  total_size_bytes: string;
  table_size: string;
  index_size: string;
  row_count: number;
  description: string | null;
}

export interface TableDetail {
  name: string;
  schema: string;
  total_size: string;
  table_size: string;
  index_size: string;
  toast_size: string;
  row_count: number;
  dead_tuples: number;
  last_vacuum: string | null;
  last_autovacuum: string | null;
  last_analyze: string | null;
  last_autoanalyze: string | null;
  seq_scan: number;
  idx_scan: number;
  columns: { name: string; type: string; nullable: boolean; default_value: string | null; description: string | null }[];
  indexes: { name: string; type: string; size: string; definition: string; is_unique: boolean; is_primary: boolean; idx_scan: number; idx_tup_read: number; idx_tup_fetch: number }[];
  constraints: { name: string; type: string; definition: string }[];
  foreignKeys: { name: string; column_name: string; referenced_table: string; referenced_column: string }[];
  sampleData: any[];
}

export interface FiredAlert {
  id: number;
  rule_id: number;
  timestamp: number;
  value: number;
  message: string;
}

export interface SchemaChangeRow {
  id: number;
  snapshot_id: number;
  timestamp: number;
  change_type: "added" | "removed" | "modified";
  object_type: "table" | "column" | "index" | "constraint" | "enum";
  table_name: string | null;
  detail: string;
}

export interface SnapshotRow {
  id: number;
  timestamp: number;
}

export interface AlertRuleRow {
  id: number;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  severity: string;
  enabled: number;
  cooldown_minutes: number;
}

export interface AlertHistoryRow {
  id: number;
  rule_id: number;
  timestamp: number;
  value: number;
  message: string;
  notified: number;
}

export const RANGES = ["5m", "15m", "1h", "6h", "24h", "7d"] as const;
export type Range = (typeof RANGES)[number];

export type Tab = "overview" | "health" | "schema" | "activity" | "alerts";

export const gradeColors: Record<string, string> = {
  A: "text-green-400 border-green-400",
  B: "text-blue-400 border-blue-400",
  C: "text-yellow-400 border-yellow-400",
  D: "text-orange-400 border-orange-400",
  F: "text-red-400 border-red-400",
};

export const gradeBg: Record<string, string> = {
  A: "bg-green-900/30",
  B: "bg-blue-900/30",
  C: "bg-yellow-900/30",
  D: "bg-orange-900/30",
  F: "bg-red-900/30",
};

export const severityBadge: Record<string, string> = {
  critical: "bg-red-900 text-red-300",
  warning: "bg-yellow-900 text-yellow-300",
  info: "bg-blue-900 text-blue-300",
};

export const categoryColors: Record<string, string> = {
  performance: "bg-purple-900 text-purple-300",
  maintenance: "bg-teal-900 text-teal-300",
  schema: "bg-indigo-900 text-indigo-300",
  security: "bg-red-900 text-red-300",
};

export const effortBadge: Record<string, string> = {
  quick: "text-green-400",
  moderate: "text-yellow-400",
  involved: "text-orange-400",
};

export const stateColor: Record<string, string> = {
  active: "text-green-400",
  "idle in transaction": "text-yellow-400",
  idle: "text-gray-500",
};

export const ALERT_METRICS = [
  { value: "connection_util", label: "Connection Utilization (%)" },
  { value: "cache_hit_pct", label: "Cache Hit Ratio (%)" },
  { value: "long_query_count", label: "Long-Running Queries" },
  { value: "idle_in_tx_count", label: "Idle in Transaction" },
  { value: "health_score", label: "Health Score" },
];
