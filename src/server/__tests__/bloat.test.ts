import { describe, it, expect, vi } from "vitest";
import { getBloatReport } from "../bloat.js";

function makePool(rows: any[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe("getBloatReport", () => {
  it("filters out tables with bloat < 10%", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "low_bloat", n_live_tup: "95", n_dead_tup: "5", last_autovacuum: null, last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    expect(report.tables).toHaveLength(0);
  });

  it("includes tables with bloat >= 10%", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "bloated", n_live_tup: "80", n_dead_tup: "20", last_autovacuum: null, last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    expect(report.tables).toHaveLength(1);
    expect(report.tables[0].bloatPercent).toBe(20);
  });

  it("correctly calculates bloatPercent", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "t1", n_live_tup: "700", n_dead_tup: "300", last_autovacuum: null, last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    expect(report.tables[0].bloatPercent).toBe(30);
  });

  it("returns correct suggestion for HIGH bloat (>= 50%)", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "very_bloated", n_live_tup: "40", n_dead_tup: "60", last_autovacuum: null, last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    expect(report.tables[0].suggestion).toMatch(/HIGH bloat/);
    expect(report.tables[0].suggestion).toMatch(/VACUUM ANALYZE/);
  });

  it("returns correct suggestion for Moderate bloat (>= 20% and < 50%)", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "mod_bloated", n_live_tup: "75", n_dead_tup: "25", last_autovacuum: null, last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    expect(report.tables[0].suggestion).toMatch(/Moderate bloat/);
  });

  it("returns correct suggestion for Minor bloat (>= 10% and < 20%)", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "minor_bloated", n_live_tup: "85", n_dead_tup: "15", last_autovacuum: null, last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    expect(report.tables[0].suggestion).toMatch(/Minor bloat/);
    expect(report.tables[0].suggestion).toMatch(/Autovacuum should handle this/);
  });

  it("handles division correctly with only live rows (no dead)", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "clean", n_live_tup: "100", n_dead_tup: "0", last_autovacuum: null, last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    // 0% bloat, should be filtered out
    expect(report.tables).toHaveLength(0);
  });

  it("sorts tables by bloatPercent DESC", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "medium", n_live_tup: "75", n_dead_tup: "25", last_autovacuum: null, last_vacuum: null },
      { schemaname: "public", table_name: "high", n_live_tup: "30", n_dead_tup: "70", last_autovacuum: null, last_vacuum: null },
      { schemaname: "public", table_name: "low_ten", n_live_tup: "88", n_dead_tup: "12", last_autovacuum: null, last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    const percents = report.tables.map((t) => t.bloatPercent);
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i - 1]).toBeGreaterThanOrEqual(percents[i]);
    }
    expect(percents[0]).toBe(70);
  });

  it("parses lastAutoVacuum as ISO string when set", async () => {
    const now = new Date();
    const pool = makePool([
      { schemaname: "public", table_name: "t1", n_live_tup: "50", n_dead_tup: "50", last_autovacuum: now.toISOString(), last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    expect(report.tables[0].lastAutoVacuum).not.toBeNull();
  });

  it("lastVacuum is null when last_vacuum is null in query result", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "t1", n_live_tup: "50", n_dead_tup: "50", last_autovacuum: null, last_vacuum: null },
    ]);
    const report = await getBloatReport(pool as any);
    expect(report.tables[0].lastVacuum).toBeNull();
  });

  it("lastVacuum is populated as ISO string when last_vacuum is non-null", async () => {
    const vacuumTime = new Date("2026-01-10T08:00:00.000Z");
    const pool = makePool([
      { schemaname: "public", table_name: "t1", n_live_tup: "50", n_dead_tup: "50", last_autovacuum: null, last_vacuum: vacuumTime.toISOString() },
    ]);
    const report = await getBloatReport(pool as any);
    expect(report.tables[0].lastVacuum).toBe(vacuumTime.toISOString());
  });
});
