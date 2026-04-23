import { describe, it, expect, vi } from "vitest";
import { getAutovacuumReport } from "../autovacuum.js";

const defaultSettings = [
  { name: "autovacuum", setting: "on" },
  { name: "autovacuum_vacuum_cost_delay", setting: "2" },
  { name: "autovacuum_max_workers", setting: "3" },
  { name: "autovacuum_naptime", setting: "60" },
];

function makePool(tableRows: any[], settingsRows = defaultSettings) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: tableRows })
    .mockResolvedValueOnce({ rows: settingsRows });
  return { query };
}

const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
};

describe("getAutovacuumReport", () => {
  it("status='never' when no vacuum history (null lastAutoVacuum and count=0)", async () => {
    const pool = makePool([
      { schemaname: "public", relname: "fresh_table", last_autovacuum: null, last_autoanalyze: null, n_dead_tup: "0", n_live_tup: "100", autovacuum_count: "0", autoanalyze_count: "0" },
    ]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.tables[0].status).toBe("never");
    expect(report.tables[0].suggestion).toContain("never been autovacuumed");
  });

  it("status='never' when lastAutoVacuum=null even if vacuumCount > 0 (Fix 6 regression)", async () => {
    // Previously this returned "ok" due to the null check gap — should return "never"
    const pool = makePool([
      { schemaname: "public", relname: "weird_table", last_autovacuum: null, last_autoanalyze: null, n_dead_tup: "0", n_live_tup: "100", autovacuum_count: "5", autoanalyze_count: "5" },
    ]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.tables[0].status).toBe("never");
  });

  it("status='overdue' when last vacuum > 7 days ago + many dead tuples", async () => {
    const pool = makePool([
      { schemaname: "public", relname: "bloated", last_autovacuum: daysAgo(10), last_autoanalyze: null, n_dead_tup: "50000", n_live_tup: "100000", autovacuum_count: "5", autoanalyze_count: "5" },
    ]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.tables[0].status).toBe("overdue");
    expect(report.tables[0].suggestion).toContain("overdue");
  });

  it("status='stale' when last vacuum > 3 days ago but not > 7 days", async () => {
    const pool = makePool([
      { schemaname: "public", relname: "stale_table", last_autovacuum: daysAgo(5), last_autoanalyze: null, n_dead_tup: "100", n_live_tup: "10000", autovacuum_count: "3", autoanalyze_count: "3" },
    ]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.tables[0].status).toBe("stale");
  });

  it("status='ok' when recently vacuumed", async () => {
    const pool = makePool([
      { schemaname: "public", relname: "ok_table", last_autovacuum: daysAgo(1), last_autoanalyze: null, n_dead_tup: "50", n_live_tup: "10000", autovacuum_count: "10", autoanalyze_count: "10" },
    ]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.tables[0].status).toBe("ok");
    expect(report.tables[0].suggestion).toBeNull();
  });

  it("status='ok' when no suggestion for ok tables", async () => {
    const pool = makePool([
      { schemaname: "public", relname: "healthy", last_autovacuum: daysAgo(0), last_autoanalyze: null, n_dead_tup: "0", n_live_tup: "500", autovacuum_count: "20", autoanalyze_count: "20" },
    ]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.tables[0].status).toBe("ok");
    expect(report.tables[0].suggestion).toBeNull();
  });

  it("parses autovacuum settings correctly with units", async () => {
    const pool = makePool([], [
      { name: "autovacuum", setting: "on" },
      { name: "autovacuum_vacuum_cost_delay", setting: "10" },
      { name: "autovacuum_max_workers", setting: "5" },
      { name: "autovacuum_naptime", setting: "120" },
    ]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.settings.autovacuumEnabled).toBe(true);
    expect(report.settings.vacuumCostDelay).toBe("10ms");
    expect(report.settings.autovacuumMaxWorkers).toBe(5);
    expect(report.settings.autovacuumNaptime).toBe("120s");
  });

  it("autovacuumEnabled=false when setting='off'", async () => {
    const pool = makePool([], [
      { name: "autovacuum", setting: "off" },
      { name: "autovacuum_vacuum_cost_delay", setting: "2" },
      { name: "autovacuum_max_workers", setting: "3" },
      { name: "autovacuum_naptime", setting: "60" },
    ]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.settings.autovacuumEnabled).toBe(false);
  });

  it("overdue requires BOTH > 7 days AND > 10000 dead tuples", async () => {
    // > 7 days but few dead tuples → stale, not overdue
    const pool = makePool([
      { schemaname: "public", relname: "t1", last_autovacuum: daysAgo(8), last_autoanalyze: null, n_dead_tup: "100", n_live_tup: "10000", autovacuum_count: "5", autoanalyze_count: "5" },
    ]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.tables[0].status).toBe("stale");
  });

  it("returns checkedAt as ISO string", async () => {
    const pool = makePool([]);
    const report = await getAutovacuumReport(pool as any);
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
