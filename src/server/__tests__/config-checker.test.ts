import { describe, it, expect, vi } from "vitest";
import { getConfigReport } from "../config-checker.js";

// Helper: build a pool mock from a settings array
function makePool(rows: Array<{ name: string; setting: string; unit?: string | null }>) {
  return { query: vi.fn().mockResolvedValue({ rows: rows.map((r) => ({ ...r, unit: r.unit ?? null })) }) };
}

// Full baseline settings — nothing should be flagged
// Note: statement_timeout removed (Fix 9d — dead code cleanup)
function baseSettings(): Array<{ name: string; setting: string; unit?: string | null }> {
  return [
    { name: "max_connections", setting: "100", unit: null },
    // shared_buffers: 256MB using unit "MB" for simplicity
    { name: "shared_buffers", setting: "256", unit: "MB" },
    { name: "work_mem", setting: "16", unit: "MB" },          // NOT 4MB
    { name: "effective_cache_size", setting: "768", unit: "MB" },
    { name: "maintenance_work_mem", setting: "256", unit: "MB" }, // NOT 64MB
    { name: "wal_buffers", setting: "-1", unit: null },
    { name: "checkpoint_completion_target", setting: "0.9", unit: null },
    { name: "random_page_cost", setting: "1.1", unit: null },
    { name: "autovacuum_vacuum_scale_factor", setting: "0.05", unit: null },
    { name: "autovacuum_analyze_scale_factor", setting: "0.02", unit: null },
    { name: "log_min_duration_statement", setting: "1000", unit: null }, // NOT -1
    { name: "idle_in_transaction_session_timeout", setting: "60000", unit: null }, // NOT 0
    { name: "effective_io_concurrency", setting: "200", unit: null },   // NOT 1
  ];
}

function settingsWith(overrides: Record<string, string>): Array<{ name: string; setting: string; unit?: string | null }> {
  return baseSettings().map((s) => overrides[s.name] !== undefined ? { ...s, setting: overrides[s.name] } : s);
}

describe("getConfigReport", () => {
  it("flags shared_buffers < 128MB as warning", async () => {
    // 64MB < 128MB → should flag
    const pool = makePool(settingsWith({ shared_buffers: "64" })); // unit MB
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "shared_buffers");
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe("warning");
    expect(rec?.recommendedValue).toBe("256MB");
  });

  it("does NOT flag shared_buffers when >= 128MB", async () => {
    const pool = makePool(baseSettings());
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "shared_buffers");
    expect(rec).toBeUndefined();
  });

  it("flags work_mem = 4MB as info", async () => {
    const pool = makePool(settingsWith({ work_mem: "4" })); // unit MB
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "work_mem");
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe("info");
    expect(rec?.recommendedValue).toBe("16MB");
  });

  it("flags work_mem = 3MB (< 4MB) as info — Fix 9c: <= threshold", async () => {
    const pool = makePool(settingsWith({ work_mem: "3" })); // unit MB, 3 <= 4
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "work_mem");
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe("info");
  });

  it("does NOT flag work_mem when not <= 4MB", async () => {
    const pool = makePool(baseSettings()); // work_mem = 16MB
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "work_mem");
    expect(rec).toBeUndefined();
  });

  it("flags checkpoint_completion_target < 0.9 as warning", async () => {
    const pool = makePool(settingsWith({ checkpoint_completion_target: "0.5" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "checkpoint_completion_target");
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe("warning");
    expect(rec?.recommendedValue).toBe("0.9");
  });

  it("does NOT flag checkpoint_completion_target when >= 0.9", async () => {
    const pool = makePool(baseSettings());
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "checkpoint_completion_target");
    expect(rec).toBeUndefined();
  });

  it("flags random_page_cost > 2.0 as info (e.g. 3.0 triggers recommendation — Fix 9a dead code)", async () => {
    // Previously `v > 2.0 && rpcSetting !== "1.1"` was used (dead code since "3.0" != "1.1" anyway)
    // After fix: just `v > 2.0` — this test verifies 3.0 triggers
    const pool = makePool(settingsWith({ random_page_cost: "3.0" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "random_page_cost");
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe("info");
    expect(rec?.recommendedValue).toBe("1.1");
  });

  it("does NOT flag random_page_cost when already = 1.1", async () => {
    const pool = makePool(baseSettings()); // random_page_cost = 1.1
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "random_page_cost");
    expect(rec).toBeUndefined();
  });

  it("flags idle_in_transaction_session_timeout = 0 as warning", async () => {
    const pool = makePool(settingsWith({ idle_in_transaction_session_timeout: "0" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "idle_in_transaction_session_timeout");
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe("warning");
    expect(rec?.recommendedValue).toBe("60000");
  });

  it("flags log_min_duration_statement = -1 as info", async () => {
    const pool = makePool(settingsWith({ log_min_duration_statement: "-1" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "log_min_duration_statement");
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe("info");
  });

  it("does NOT flag log_min_duration_statement when already set", async () => {
    const pool = makePool(baseSettings()); // log_min_duration_statement = 1000
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "log_min_duration_statement");
    expect(rec).toBeUndefined();
  });

  it("flags autovacuum_vacuum_scale_factor >= 0.2 as info", async () => {
    const pool = makePool(settingsWith({ autovacuum_vacuum_scale_factor: "0.2" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "autovacuum_vacuum_scale_factor");
    expect(rec).toBeDefined();
    expect(rec?.recommendedValue).toBe("0.05");
  });

  it("flags maintenance_work_mem = 64MB as info", async () => {
    const pool = makePool(settingsWith({ maintenance_work_mem: "64" })); // unit MB
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "maintenance_work_mem");
    expect(rec).toBeDefined();
    expect(rec?.recommendedValue).toBe("256MB");
  });

  it("flags effective_io_concurrency = 1 as info", async () => {
    const pool = makePool(settingsWith({ effective_io_concurrency: "1" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "effective_io_concurrency");
    expect(rec).toBeDefined();
    expect(rec?.recommendedValue).toBe("200");
  });

  it("returns correct serverInfo fields — Fix 9b: human-readable memory values", async () => {
    const pool = makePool(baseSettings());
    const report = await getConfigReport(pool as any);
    expect(report.serverInfo.maxConnections).toBe(100);
    // totalMemoryMb removed (Fix 9e) — no longer in serverInfo
    expect(typeof report.serverInfo.sharedBuffers).toBe("string");
    expect(typeof report.serverInfo.workMem).toBe("string");
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sharedBuffers in serverInfo is returned as human-readable MB string — Fix 9b", async () => {
    // shared_buffers = "256" with unit "MB" → formatMemSetting → "256MB"
    const pool = makePool(baseSettings());
    const report = await getConfigReport(pool as any);
    expect(report.serverInfo.sharedBuffers).toBe("256MB");
    // Should NOT be raw numeric string like "256" or "268435456"
    expect(report.serverInfo.sharedBuffers).not.toBe("256");
  });

  it("workMem in serverInfo is returned as human-readable string — Fix 9b", async () => {
    const pool = makePool(baseSettings()); // work_mem = 16MB
    const report = await getConfigReport(pool as any);
    expect(report.serverInfo.workMem).toBe("16MB");
  });

  it("serverInfo does NOT contain totalMemoryMb — Fix 9e: removed null stub", async () => {
    const pool = makePool(baseSettings());
    const report = await getConfigReport(pool as any);
    // totalMemoryMb was always null and misleading — should be absent
    expect("totalMemoryMb" in report.serverInfo).toBe(false);
  });

  it("with all recommended values, returns zero recommendations", async () => {
    const pool = makePool(baseSettings());
    const report = await getConfigReport(pool as any);
    // Should have no recommendations since base settings are all fine
    expect(report.recommendations).toHaveLength(0);
  });

  // --- Fix 1: work_mem currentValue is not hardcoded ---

  it("work_mem = 3MB recommendation has currentValue '3MB' (not hardcoded '4MB')", async () => {
    const pool = makePool(settingsWith({ work_mem: "3" })); // 3MB, unit MB
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "work_mem");
    expect(rec).toBeDefined();
    expect(rec?.currentValue).toBe("3MB");
  });

  it("work_mem = 2MB recommendation has currentValue '2MB'", async () => {
    const pool = makePool(settingsWith({ work_mem: "2" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "work_mem");
    expect(rec).toBeDefined();
    expect(rec?.currentValue).toBe("2MB");
  });

  it("maintenance_work_mem = 32MB recommendation has currentValue '32MB' (not hardcoded '64MB')", async () => {
    const pool = makePool(settingsWith({ maintenance_work_mem: "32" })); // 32MB, unit MB
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "maintenance_work_mem");
    expect(rec).toBeDefined();
    expect(rec?.currentValue).toBe("32MB");
  });

  // --- Fix 2: max_connections check ---

  it("max_connections = 300 adds a recommendation with severity 'warning'", async () => {
    const pool = makePool(settingsWith({ max_connections: "300" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "max_connections");
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe("warning");
  });

  it("max_connections = 300 recommendation has currentValue '300'", async () => {
    const pool = makePool(settingsWith({ max_connections: "300" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "max_connections");
    expect(rec).toBeDefined();
    expect(rec?.currentValue).toBe("300");
  });

  it("max_connections = 100 does NOT add a recommendation", async () => {
    const pool = makePool(baseSettings()); // max_connections = 100
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "max_connections");
    expect(rec).toBeUndefined();
  });

  it("max_connections = 200 does NOT add a recommendation (threshold is > 200, not >= 200)", async () => {
    const pool = makePool(settingsWith({ max_connections: "200" }));
    const report = await getConfigReport(pool as any);
    const rec = report.recommendations.find((r) => r.setting === "max_connections");
    expect(rec).toBeUndefined();
  });
});
