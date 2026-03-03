import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  analyzeExplainPlan,
  detectQueryRegressions,
  type ExplainAnalysis,
} from "../query-analyzer.js";

// ─── Helper to build a minimal EXPLAIN JSON ───────────────────────────────────

function makeExplainJson(planNode: any, opts: { planningTime?: number; executionTime?: number } = {}): any[] {
  const top: any = { Plan: planNode };
  if (opts.planningTime !== undefined) top["Planning Time"] = opts.planningTime;
  if (opts.executionTime !== undefined) top["Execution Time"] = opts.executionTime;
  return [top];
}

function seqScanNode(opts: {
  table?: string;
  planRows?: number;
  actualRows?: number;
  filter?: string;
  plans?: any[];
}): any {
  const node: any = {
    "Node Type": "Seq Scan",
    "Relation Name": opts.table ?? "test_table",
    "Plan Rows": opts.planRows ?? 100,
    "Total Cost": 500,
  };
  if (opts.actualRows !== undefined) node["Actual Rows"] = opts.actualRows;
  if (opts.filter) node["Filter"] = opts.filter;
  if (opts.plans) node["Plans"] = opts.plans;
  return node;
}

function indexScanNode(table = "test_table"): any {
  return {
    "Node Type": "Index Scan",
    "Relation Name": table,
    "Total Cost": 10,
    "Plan Rows": 5,
  };
}

// ─── 1. Parse Seq Scan node ────────────────────────────────────────────────────

describe("analyzeExplainPlan — Seq Scan detection", () => {
  it("detects a simple Seq Scan node", async () => {
    const json = makeExplainJson(seqScanNode({ table: "users", planRows: 500 }));
    const analysis = await analyzeExplainPlan(json, null);
    expect(analysis.seqScans).toHaveLength(1);
    expect(analysis.seqScans[0].table).toBe("users");
  });

  it("does NOT flag Index Scan nodes as seq scans", async () => {
    const json = makeExplainJson(indexScanNode("orders"));
    const analysis = await analyzeExplainPlan(json, null);
    expect(analysis.seqScans).toHaveLength(0);
  });

  // ── 2. Filter on Seq Scan ──────────────────────────────────────────────────

  it("captures filter condition on Seq Scan", async () => {
    const json = makeExplainJson(
      seqScanNode({ table: "chat_messages", planRows: 200_000, filter: "(room_id = $1)" })
    );
    const analysis = await analyzeExplainPlan(json, null);
    expect(analysis.seqScans[0].filter).toBe("(room_id = $1)");
  });

  // ── 3. Missing index suggested (no pool = static analysis only) ───────────

  it("suggests index when there is a Filter and no pool (static)", async () => {
    const json = makeExplainJson(
      seqScanNode({ table: "messages", planRows: 50_000, filter: "(user_id = $1)" })
    );
    const analysis = await analyzeExplainPlan(json, null);
    expect(analysis.missingIndexes.length).toBeGreaterThan(0);
    expect(analysis.missingIndexes[0].table).toBe("messages");
    expect(analysis.missingIndexes[0].columns).toContain("user_id");
    expect(analysis.missingIndexes[0].sql).toMatch(/CREATE INDEX CONCURRENTLY/i);
  });

  // ── 4. Existing index suppresses suggestion ────────────────────────────────

  it("does NOT suggest index when pool reports existing index covers the column", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ indexdef: "CREATE INDEX idx_orders_status ON orders (status)" }],
      }),
    } as any;

    const json = makeExplainJson(
      seqScanNode({ table: "orders", planRows: 500_000, filter: "(status = $1)" })
    );
    const analysis = await analyzeExplainPlan(json, mockPool);
    // status is already indexed → no new suggestion
    expect(analysis.missingIndexes.filter(m => m.columns[0] === "status")).toHaveLength(0);
  });

  // ── 5. Large table → benefit: high ────────────────────────────────────────

  it("rates benefit as 'high' for tables > 100k rows", async () => {
    const json = makeExplainJson(
      seqScanNode({ table: "events", planRows: 500_000, filter: "(event_type = $1)" })
    );
    const analysis = await analyzeExplainPlan(json, null);
    const suggestion = analysis.missingIndexes.find(m => m.table === "events");
    expect(suggestion).toBeDefined();
    expect(suggestion!.estimatedBenefit).toBe("high");
  });

  // ── 6. Small table → benefit: low ─────────────────────────────────────────

  it("rates benefit as 'low' for tables < 10k rows", async () => {
    const json = makeExplainJson(
      seqScanNode({ table: "settings", planRows: 50, filter: "(key = $1)" })
    );
    const analysis = await analyzeExplainPlan(json, null);
    const suggestion = analysis.missingIndexes.find(m => m.table === "settings");
    expect(suggestion?.estimatedBenefit).toBe("low");
  });

  // ── 7. Recommendations list non-empty ────────────────────────────────────

  it("returns non-empty recommendations for large Seq Scans", async () => {
    const json = makeExplainJson(
      seqScanNode({ table: "logs", planRows: 2_000_000, filter: "(level = $1)" }),
      { planningTime: 5 }
    );
    const analysis = await analyzeExplainPlan(json, null);
    expect(analysis.recommendations.length).toBeGreaterThan(0);
    expect(analysis.recommendations.some(r => r.includes("logs"))).toBe(true);
  });

  // ── 8. Basic costEstimate structure ───────────────────────────────────────

  it("populates costEstimate with totalCost and optional times", async () => {
    const json = makeExplainJson(
      seqScanNode({ planRows: 100 }),
      { planningTime: 3.5, executionTime: 12.7 }
    );
    const analysis = await analyzeExplainPlan(json, null);
    expect(analysis.costEstimate.totalCost).toBeGreaterThanOrEqual(0);
    expect(analysis.costEstimate.planningTime).toBe(3.5);
    expect(analysis.costEstimate.actualTime).toBe(12.7);
  });

  // ── 9. Empty plan → no crash ───────────────────────────────────────────────

  it("returns empty analysis for null/empty plan without throwing", async () => {
    const analysis1 = await analyzeExplainPlan(null, null);
    expect(analysis1.seqScans).toHaveLength(0);
    expect(analysis1.missingIndexes).toHaveLength(0);

    const analysis2 = await analyzeExplainPlan([], null);
    expect(analysis2.seqScans).toHaveLength(0);

    const analysis3 = await analyzeExplainPlan([{}], null);
    expect(analysis3.seqScans).toHaveLength(0);
  });

  // ── 10. Nested sub-query → all nodes traversed ────────────────────────────

  it("traverses nested plan nodes (sub-queries)", async () => {
    const innerSeqScan = seqScanNode({ table: "inner_table", planRows: 200_000, filter: "(col = $1)" });
    const outerNode = {
      "Node Type": "Hash Join",
      "Total Cost": 1000,
      "Plan Rows": 500,
      Plans: [
        indexScanNode("outer_table"),
        {
          "Node Type": "Hash",
          "Total Cost": 600,
          "Plan Rows": 200_000,
          Plans: [innerSeqScan],
        },
      ],
    };
    const json = makeExplainJson(outerNode);
    const analysis = await analyzeExplainPlan(json, null);

    expect(analysis.planNodes.some(n => n.nodeType === "Hash Join")).toBe(true);
    expect(analysis.planNodes.some(n => n.nodeType === "Seq Scan")).toBe(true);
    expect(analysis.seqScans.some(s => s.table === "inner_table")).toBe(true);
    expect(analysis.missingIndexes.some(m => m.table === "inner_table")).toBe(true);
  });
});

// ─── detectQueryRegressions ───────────────────────────────────────────────────

describe("detectQueryRegressions", () => {
  // ── 11. Detects 50%+ degradation ──────────────────────────────────────────

  it("detects regression when current mean is > 50% higher than baseline", async () => {
    const now = Date.now();
    const yesterday = now - 23 * 60 * 60 * 1000;

    // Fake pool with pg_stat_statements available and current mean = 150ms
    const mockPool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("pg_extension")) {
          return Promise.resolve({ rows: [{ "?column?": 1 }] }); // extension exists
        }
        // pg_stat_statements current snapshot
        return Promise.resolve({
          rows: [{ queryid: "abc123", mean_exec_time: "150" }],
        });
      }),
    } as any;

    // Fake SQLite DB with baseline mean = 80ms (regression = +87.5%)
    const mockStatsDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([
          { queryid: "abc123", mean_exec_time: 80, timestamp: yesterday },
        ]),
      }),
    } as any;

    const regressions = await detectQueryRegressions(mockPool, mockStatsDb, 24);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].queryId).toBe("abc123");
    expect(regressions[0].changePercent).toBeGreaterThan(50);
    expect(regressions[0].currentMeanMs).toBe(150);
    expect(regressions[0].previousMeanMs).toBe(80);
  });

  // ── 12. Graceful degradation when pg_stat_statements is absent ─────────────

  it("returns empty array when pg_stat_statements is not installed", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }), // no extension
    } as any;

    const regressions = await detectQueryRegressions(mockPool, null, 24);
    expect(regressions).toHaveLength(0);
  });

  // Bonus: no regression when change < 50%
  it("does not flag queries with < 50% change", async () => {
    const now = Date.now();
    const yesterday = now - 23 * 60 * 60 * 1000;

    const mockPool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("pg_extension")) return Promise.resolve({ rows: [{ "?column?": 1 }] });
        return Promise.resolve({
          rows: [{ queryid: "xyz", mean_exec_time: "110" }], // +10% over 100ms
        });
      }),
    } as any;

    const mockStatsDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([
          { queryid: "xyz", mean_exec_time: 100, timestamp: yesterday },
        ]),
      }),
    } as any;

    const regressions = await detectQueryRegressions(mockPool, mockStatsDb, 24);
    expect(regressions).toHaveLength(0);
  });
});

// ─── Composite index suggestions ─────────────────────────────────────────────

describe("analyzeExplainPlan — composite index suggestions", () => {
  it("suggests composite index for two-column filter (not two separate indexes)", async () => {
    const json = makeExplainJson(
      seqScanNode({ table: "orders", planRows: 50_000, filter: "(user_id = $1 AND status = $2)" })
    );
    const analysis = await analyzeExplainPlan(json, null);

    expect(analysis.missingIndexes).toHaveLength(1);
    const suggestion = analysis.missingIndexes[0];
    expect(suggestion.table).toBe("orders");
    expect(suggestion.columns).toHaveLength(2);
    expect(suggestion.columns).toContain("user_id");
    expect(suggestion.columns).toContain("status");
    expect(suggestion.sql).toMatch(/user_id, status|status, user_id/);
    expect(suggestion.reason).toContain("composite index preferred");
  });

  it("suggests composite index for three-column filter", async () => {
    const json = makeExplainJson(
      seqScanNode({
        table: "events",
        planRows: 200_000,
        filter: "(tenant_id = $1 AND event_type = $2 AND created_at > $3)",
      })
    );
    const analysis = await analyzeExplainPlan(json, null);

    expect(analysis.missingIndexes).toHaveLength(1);
    expect(analysis.missingIndexes[0].columns.length).toBeGreaterThanOrEqual(2);
    expect(analysis.missingIndexes[0].reason).toContain("composite index preferred");
  });

  it("composite covers only uncovered columns when one is already indexed", async () => {
    // user_id is already the leading column of an existing index; status is not
    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ indexdef: "CREATE INDEX idx_orders_user_id ON orders (user_id)" }],
      }),
    } as any;

    const json = makeExplainJson(
      seqScanNode({ table: "orders", planRows: 80_000, filter: "(user_id = $1 AND status = $2)" })
    );
    const analysis = await analyzeExplainPlan(json, mockPool);

    // Only status is uncovered → single column suggestion (not composite)
    expect(analysis.missingIndexes).toHaveLength(1);
    expect(analysis.missingIndexes[0].columns).toEqual(["status"]);
    expect(analysis.missingIndexes[0].reason).not.toContain("composite");
  });

  it("no suggestion when all filter columns are already indexed", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { indexdef: "CREATE INDEX idx_orders_user_id ON orders (user_id)" },
          { indexdef: "CREATE INDEX idx_orders_status ON orders (status)" },
        ],
      }),
    } as any;

    const json = makeExplainJson(
      seqScanNode({ table: "orders", planRows: 80_000, filter: "(user_id = $1 AND status = $2)" })
    );
    const analysis = await analyzeExplainPlan(json, mockPool);

    expect(analysis.missingIndexes).toHaveLength(0);
  });
});
