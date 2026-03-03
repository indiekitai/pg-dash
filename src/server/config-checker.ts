import type { Pool } from "pg";

export interface ConfigRecommendation {
  setting: string;
  currentValue: string;
  recommendedValue: string;
  reason: string;
  severity: "error" | "warning" | "info";
  docs?: string;
}

export interface ConfigReport {
  recommendations: ConfigRecommendation[];
  serverInfo: {
    maxConnections: number;
    sharedBuffers: string;
    workMem: string;
    effectiveCacheSize: string;
    maintenanceWorkMem: string;
    walBuffers: string;
    checkpointCompletionTarget: string;
    randomPageCost: string;
    autovacuumVacuumScaleFactor: string;
  };
  checkedAt: string;
}

// Convert a setting value + unit to bytes for comparison
// In pg_settings, 'setting' is in the displayed 'unit'
function settingToBytes(value: string, unit: string | undefined): number {
  const v = parseFloat(value);
  if (!unit) return v;
  switch (unit.toLowerCase()) {
    case "b":   return v;
    case "kb":  return v * 1024;
    case "8kb": return v * 8 * 1024;   // shared_buffers, effective_cache_size
    case "mb":  return v * 1024 * 1024;
    case "gb":  return v * 1024 * 1024 * 1024;
    default:    return v;
  }
}

function settingToMb(value: string, unit: string | undefined): number {
  return settingToBytes(value, unit) / (1024 * 1024);
}

// Format a memory setting to a human-readable string with units
function formatMemSetting(rawValue: string | null | undefined, unit?: string): string {
  if (!rawValue) return "unknown";
  const bytes = settingToBytes(rawValue, unit ?? "");
  if (bytes <= 0 || isNaN(bytes)) return rawValue; // fallback for special values like -1 (auto)
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export async function getConfigReport(pool: Pool): Promise<ConfigReport> {
  const result = await pool.query(`
    SELECT name, setting, unit
    FROM pg_settings
    WHERE name IN (
      'max_connections', 'shared_buffers', 'work_mem',
      'effective_cache_size', 'maintenance_work_mem', 'wal_buffers',
      'checkpoint_completion_target', 'random_page_cost',
      'autovacuum_vacuum_scale_factor', 'autovacuum_analyze_scale_factor',
      'log_min_duration_statement', 'idle_in_transaction_session_timeout',
      'effective_io_concurrency'
    )
  `);

  const settings: Record<string, { setting: string; unit: string | undefined }> = {};
  for (const row of result.rows) {
    settings[row.name] = { setting: row.setting, unit: row.unit ?? undefined };
  }

  const recommendations: ConfigRecommendation[] = [];

  const get = (name: string) => settings[name]?.setting ?? null;
  const getUnit = (name: string) => settings[name]?.unit;

  // 1. shared_buffers: < 128MB → warning
  const sharedBuffersSetting = get("shared_buffers");
  if (sharedBuffersSetting !== null) {
    const mb = settingToMb(sharedBuffersSetting, getUnit("shared_buffers"));
    if (mb < 128) {
      recommendations.push({
        setting: "shared_buffers",
        currentValue: `${Math.round(mb)}MB`,
        recommendedValue: "256MB",
        reason: "shared_buffers should be at least 25% of RAM; typical starting point is 256MB–1GB",
        severity: "warning",
        docs: "https://www.postgresql.org/docs/current/runtime-config-resource.html#GUC-SHARED-BUFFERS",
      });
    }
  }

  // 2. work_mem: <= 4MB → info
  const workMemSetting = get("work_mem");
  if (workMemSetting !== null) {
    const mb = settingToMb(workMemSetting, getUnit("work_mem"));
    if (mb <= 4) {
      recommendations.push({
        setting: "work_mem",
        currentValue: "4MB",
        recommendedValue: "16MB",
        reason: "work_mem of 4MB is conservative; consider 16MB–64MB for analytical queries (but multiply by max_connections for total)",
        severity: "info",
        docs: "https://www.postgresql.org/docs/current/runtime-config-resource.html#GUC-WORK-MEM",
      });
    }
  }

  // 3. checkpoint_completion_target: < 0.9 → warning
  const cctSetting = get("checkpoint_completion_target");
  if (cctSetting !== null) {
    const v = parseFloat(cctSetting);
    if (v < 0.9) {
      recommendations.push({
        setting: "checkpoint_completion_target",
        currentValue: cctSetting,
        recommendedValue: "0.9",
        reason: "Set to 0.9 to spread checkpoint I/O over 90% of checkpoint interval",
        severity: "warning",
        docs: "https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-CHECKPOINT-COMPLETION-TARGET",
      });
    }
  }

  // 4. random_page_cost: > 2.0 → info
  const rpcSetting = get("random_page_cost");
  if (rpcSetting !== null) {
    const v = parseFloat(rpcSetting);
    if (v > 2.0) {
      recommendations.push({
        setting: "random_page_cost",
        currentValue: rpcSetting,
        recommendedValue: "1.1",
        reason: "If using SSDs, set random_page_cost=1.1 (default 4.0 is tuned for spinning disks)",
        severity: "info",
        docs: "https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-RANDOM-PAGE-COST",
      });
    }
  }

  // 5. autovacuum_vacuum_scale_factor: >= 0.2 → info
  const avsfSetting = get("autovacuum_vacuum_scale_factor");
  if (avsfSetting !== null) {
    const v = parseFloat(avsfSetting);
    if (v >= 0.2) {
      recommendations.push({
        setting: "autovacuum_vacuum_scale_factor",
        currentValue: avsfSetting,
        recommendedValue: "0.05",
        reason: "Consider lowering to 0.05–0.1 for large tables to vacuum more frequently",
        severity: "info",
        docs: "https://www.postgresql.org/docs/current/runtime-config-autovacuum.html#GUC-AUTOVACUUM-VACUUM-SCALE-FACTOR",
      });
    }
  }

  // 6. log_min_duration_statement: = -1 → info
  const lmdsSetting = get("log_min_duration_statement");
  if (lmdsSetting !== null && parseInt(lmdsSetting, 10) === -1) {
    recommendations.push({
      setting: "log_min_duration_statement",
      currentValue: "-1",
      recommendedValue: "1000",
      reason: "Consider setting to 1000 (log queries > 1s) for performance monitoring",
      severity: "info",
      docs: "https://www.postgresql.org/docs/current/runtime-config-logging.html#GUC-LOG-MIN-DURATION-STATEMENT",
    });
  }

  // 7. idle_in_transaction_session_timeout: = 0 → warning
  const iitsSetting = get("idle_in_transaction_session_timeout");
  if (iitsSetting !== null && parseInt(iitsSetting, 10) === 0) {
    recommendations.push({
      setting: "idle_in_transaction_session_timeout",
      currentValue: "0",
      recommendedValue: "60000",
      reason: "Set idle_in_transaction_session_timeout=60000 (60s) to prevent stuck transactions from holding locks",
      severity: "warning",
      docs: "https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT",
    });
  }

  // 8. effective_io_concurrency: = 1 → info
  const eicSetting = get("effective_io_concurrency");
  if (eicSetting !== null && parseInt(eicSetting, 10) === 1) {
    recommendations.push({
      setting: "effective_io_concurrency",
      currentValue: "1",
      recommendedValue: "200",
      reason: "If using SSDs, set effective_io_concurrency=200 for better parallel I/O",
      severity: "info",
      docs: "https://www.postgresql.org/docs/current/runtime-config-resource.html#GUC-EFFECTIVE-IO-CONCURRENCY",
    });
  }

  // 9. wal_buffers: skip if -1 (auto)

  // 10. maintenance_work_mem: <= 64MB → info
  const mwmSetting = get("maintenance_work_mem");
  if (mwmSetting !== null) {
    const mb = settingToMb(mwmSetting, getUnit("maintenance_work_mem"));
    if (mb <= 64) {
      recommendations.push({
        setting: "maintenance_work_mem",
        currentValue: "64MB",
        recommendedValue: "256MB",
        reason: "Consider 256MB for faster VACUUM and index builds",
        severity: "info",
        docs: "https://www.postgresql.org/docs/current/runtime-config-resource.html#GUC-MAINTENANCE-WORK-MEM",
      });
    }
  }

  const maxConnSetting = get("max_connections");

  const serverInfo = {
    maxConnections: maxConnSetting !== null ? parseInt(maxConnSetting, 10) : 0,
    sharedBuffers: formatMemSetting(sharedBuffersSetting, getUnit("shared_buffers")),
    workMem: formatMemSetting(workMemSetting, getUnit("work_mem")),
    effectiveCacheSize: formatMemSetting(get("effective_cache_size"), getUnit("effective_cache_size")),
    maintenanceWorkMem: formatMemSetting(mwmSetting, getUnit("maintenance_work_mem")),
    walBuffers: get("wal_buffers") ?? "",
    checkpointCompletionTarget: cctSetting ?? "",
    randomPageCost: rpcSetting ?? "",
    autovacuumVacuumScaleFactor: avsfSetting ?? "",
  };

  return {
    recommendations,
    serverInfo,
    checkedAt: new Date().toISOString(),
  };
}
