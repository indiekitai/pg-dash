import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  diffEnvironments,
  formatTextDiff,
  formatMdDiff,
  type EnvDiffResult,
} from "../env-differ.js";

// ── helpers ──────────────────────────────────────────────────────────────────

type QueryHandler = (sql: string) => { rows: any[] };

function makePool(handler: QueryHandler) {
  return {
    query: vi.fn(async (sql: string) => handler(sql.trim())),
    end: vi.fn(async () => {}),
  } as unknown as import("pg").Pool;
}

// Row factories
const tableRow = (table_name: string) => ({ table_name });
const colRow = (
  table_name: string,
  column_name: string,
  data_type: string,
  is_nullable = "NO",
  column_default: string | null = null
) => ({ table_name, column_name, data_type, is_nullable, column_default });
const idxRow = (tablename: string, indexname: string, indexdef = `CREATE INDEX ${indexname} ON ${tablename} (col)`) => ({ tablename, indexname, indexdef });

// Helpers to identify the query type from its SQL snippet
function isTables(sql: string) { return sql.includes("information_schema.tables"); }
function isColumns(sql: string) { return sql.includes("information_schema.columns"); }
function isIndexes(sql: string) { return sql.includes("pg_indexes"); }

// ── mock diffEnvironments with Pool injection ──────────────────────────────
// We need to intercept Pool construction. Use vi.mock to replace the pg module.

vi.mock("pg", () => {
  // We expose a way to set the next two pools from each test
  const pools: Array<import("pg").Pool> = [];
  const Pool = vi.fn(() => pools.shift());
  // Expose the pools array so tests can push into it
  (Pool as any).__pools = pools;
  return { Pool };
});

vi.mock("../advisor.js", () => ({
  getAdvisorReport: vi.fn(async () => ({
    score: 100,
    grade: "A",
    issues: [],
    breakdown: {},
    skipped: [],
    ignoredCount: 0,
    batchFixes: [],
  })),
}));

async function runDiff(srcHandler: QueryHandler, tgtHandler: QueryHandler, opts?: { includeHealth?: boolean }) {
  const { Pool } = await import("pg");
  const pools = (Pool as any).__pools as import("pg").Pool[];
  pools.push(makePool(srcHandler), makePool(tgtHandler));
  return diffEnvironments("postgresql://src/db", "postgresql://tgt/db", opts);
}

// ── schema query response builders ───────────────────────────────────────────

function makeSchemaHandler(
  tables: string[],
  cols: ReturnType<typeof colRow>[],
  idxs: ReturnType<typeof idxRow>[]
): QueryHandler {
  return (sql) => {
    if (isTables(sql)) return { rows: tables.map(tableRow) };
    if (isColumns(sql)) return { rows: cols };
    if (isIndexes(sql)) return { rows: idxs };
    return { rows: [] };
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("diffEnvironments — schema", () => {
  it("identical schemas → 0 drifts, identical=true", async () => {
    const tables = ["users", "posts"];
    const cols = [
      colRow("users", "id", "bigint"),
      colRow("users", "email", "text"),
      colRow("posts", "id", "bigint"),
    ];
    const idxs = [idxRow("users", "idx_users_email")];
    const handler = makeSchemaHandler(tables, cols, idxs);

    const result = await runDiff(handler, handler);

    expect(result.summary.identical).toBe(true);
    expect(result.summary.schemaDrifts).toBe(0);
    expect(result.schema.missingTables).toHaveLength(0);
    expect(result.schema.extraTables).toHaveLength(0);
    expect(result.schema.columnDiffs).toHaveLength(0);
    expect(result.schema.indexDiffs).toHaveLength(0);
  });

  it("source has table target doesn't → missingTables", async () => {
    const srcHandler = makeSchemaHandler(["users", "live_rooms"], [], []);
    const tgtHandler = makeSchemaHandler(["users"], [], []);

    const result = await runDiff(srcHandler, tgtHandler);

    expect(result.schema.missingTables).toContain("live_rooms");
    expect(result.schema.extraTables).toHaveLength(0);
    expect(result.summary.schemaDrifts).toBe(1);
    expect(result.summary.identical).toBe(false);
  });

  it("target has table source doesn't → extraTables", async () => {
    const srcHandler = makeSchemaHandler(["users"], [], []);
    const tgtHandler = makeSchemaHandler(["users", "ghost_table"], [], []);

    const result = await runDiff(srcHandler, tgtHandler);

    expect(result.schema.extraTables).toContain("ghost_table");
    expect(result.schema.missingTables).toHaveLength(0);
    expect(result.summary.schemaDrifts).toBe(1);
  });

  it("column missing in target → columnDiffs.missingColumns", async () => {
    const srcHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint"), colRow("users", "created_at", "timestamp")],
      []
    );
    const tgtHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint")],
      []
    );

    const result = await runDiff(srcHandler, tgtHandler);

    expect(result.schema.columnDiffs).toHaveLength(1);
    const diff = result.schema.columnDiffs[0];
    expect(diff.table).toBe("users");
    expect(diff.missingColumns.map((c) => c.name)).toContain("created_at");
    expect(result.summary.schemaDrifts).toBe(1);
  });

  it("column extra in target → columnDiffs.extraColumns", async () => {
    const srcHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint")],
      []
    );
    const tgtHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint"), colRow("users", "extra_col", "text")],
      []
    );

    const result = await runDiff(srcHandler, tgtHandler);

    expect(result.schema.columnDiffs).toHaveLength(1);
    const diff = result.schema.columnDiffs[0];
    expect(diff.extraColumns.map((c) => c.name)).toContain("extra_col");
  });

  it("column type diff → typeDiffs", async () => {
    const srcHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "age", "integer")],
      []
    );
    const tgtHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "age", "bigint")],
      []
    );

    const result = await runDiff(srcHandler, tgtHandler);

    expect(result.schema.columnDiffs).toHaveLength(1);
    const diff = result.schema.columnDiffs[0];
    expect(diff.typeDiffs).toHaveLength(1);
    expect(diff.typeDiffs[0].column).toBe("age");
    expect(diff.typeDiffs[0].sourceType).toBe("integer");
    expect(diff.typeDiffs[0].targetType).toBe("bigint");
    expect(result.summary.schemaDrifts).toBe(1);
  });

  it("index missing in target → indexDiffs.missingIndexes", async () => {
    const srcHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint")],
      [idxRow("users", "idx_users_email")]
    );
    const tgtHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint")],
      []
    );

    const result = await runDiff(srcHandler, tgtHandler);

    expect(result.schema.indexDiffs).toHaveLength(1);
    expect(result.schema.indexDiffs[0].missingIndexes).toContain("idx_users_email");
  });

  it("index extra in target → indexDiffs.extraIndexes", async () => {
    const srcHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint")],
      []
    );
    const tgtHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint")],
      [idxRow("users", "idx_users_extra")]
    );

    const result = await runDiff(srcHandler, tgtHandler);

    expect(result.schema.indexDiffs).toHaveLength(1);
    expect(result.schema.indexDiffs[0].extraIndexes).toContain("idx_users_extra");
  });

  it("empty databases → no crash, identical=true", async () => {
    const handler = makeSchemaHandler([], [], []);
    const result = await runDiff(handler, handler);

    expect(result.summary.identical).toBe(true);
    expect(result.summary.schemaDrifts).toBe(0);
    expect(result.schema.missingTables).toHaveLength(0);
    expect(result.schema.columnDiffs).toHaveLength(0);
    expect(result.schema.indexDiffs).toHaveLength(0);
  });

  it("summary.schemaDrifts counts correctly across all drift types", async () => {
    // 1 missing table + 1 extra table + 1 missing col + 1 type diff + 1 missing index = 5
    const srcHandler = makeSchemaHandler(
      ["users", "missing_table"],
      [colRow("users", "id", "bigint"), colRow("users", "src_only", "text"), colRow("users", "typed", "integer")],
      [idxRow("users", "idx_users_src")]
    );
    const tgtHandler = makeSchemaHandler(
      ["users", "extra_table"],
      [colRow("users", "id", "bigint"), colRow("users", "typed", "bigint")],
      []
    );

    const result = await runDiff(srcHandler, tgtHandler);

    // missing_table: 1, extra_table: 1, src_only col: 1, typed type diff: 1, idx_users_src: 1 = 5
    expect(result.summary.schemaDrifts).toBe(5);
    expect(result.summary.identical).toBe(false);
  });

  it("checkedAt is an ISO date string", async () => {
    const handler = makeSchemaHandler([], [], []);
    const result = await runDiff(handler, handler);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── Health diff tests ─────────────────────────────────────────────────────────

describe("diffEnvironments — health", () => {
  it("health diff: higher score in source", async () => {
    const { getAdvisorReport } = await import("../advisor.js");
    const mockAdvisor = vi.mocked(getAdvisorReport);

    const handler = makeSchemaHandler([], [], []);
    const { Pool } = await import("pg");
    const pools = (Pool as any).__pools as import("pg").Pool[];
    const srcPool = makePool(handler);
    const tgtPool = makePool(handler);
    pools.push(srcPool, tgtPool);

    mockAdvisor
      .mockResolvedValueOnce({ score: 89, grade: "B", issues: [], breakdown: {}, skipped: [], ignoredCount: 0, batchFixes: [] } as any)
      .mockResolvedValueOnce({ score: 72, grade: "C", issues: [], breakdown: {}, skipped: [], ignoredCount: 0, batchFixes: [] } as any);

    const result = await diffEnvironments("postgresql://src/db", "postgresql://tgt/db", { includeHealth: true });

    expect(result.health).toBeDefined();
    expect(result.health!.source.score).toBe(89);
    expect(result.health!.target.score).toBe(72);
    expect(result.health!.source.grade).toBe("B");
    expect(result.health!.target.grade).toBe("C");
  });

  it("health diff: target-only issues detected", async () => {
    const { getAdvisorReport } = await import("../advisor.js");
    const mockAdvisor = vi.mocked(getAdvisorReport);

    const handler = makeSchemaHandler([], [], []);
    const { Pool } = await import("pg");
    const pools = (Pool as any).__pools as import("pg").Pool[];
    pools.push(makePool(handler), makePool(handler));

    const sharedIssue = { id: "shared", severity: "warning", category: "performance", title: "Shared issue", description: "", fix: "", impact: "", effort: "quick" };
    const targetOnlyIssue = { id: "tgt-only", severity: "warning", category: "maintenance", title: "Idle connections found", description: "", fix: "", impact: "", effort: "quick" };

    mockAdvisor
      .mockResolvedValueOnce({ score: 95, grade: "A", issues: [sharedIssue], breakdown: {}, skipped: [], ignoredCount: 0, batchFixes: [] } as any)
      .mockResolvedValueOnce({ score: 80, grade: "B", issues: [sharedIssue, targetOnlyIssue], breakdown: {}, skipped: [], ignoredCount: 0, batchFixes: [] } as any);

    const result = await diffEnvironments("postgresql://src/db", "postgresql://tgt/db", { includeHealth: true });

    expect(result.health!.targetOnlyIssues).toHaveLength(1);
    expect(result.health!.targetOnlyIssues[0]).toContain("Idle connections found");
    expect(result.health!.sourceOnlyIssues).toHaveLength(0);
  });

  it("health not included when includeHealth is false", async () => {
    const handler = makeSchemaHandler([], [], []);
    const result = await runDiff(handler, handler, { includeHealth: false });
    expect(result.health).toBeUndefined();
  });
});

// ── Format tests ──────────────────────────────────────────────────────────────

function makeDiffResult(overrides: Partial<EnvDiffResult> = {}): EnvDiffResult {
  return {
    schema: {
      missingTables: ["live_rooms", "live_viewers"],
      extraTables: [],
      columnDiffs: [
        {
          table: "kol_applications",
          missingColumns: [{ name: "updated_at", type: "timestamp", nullable: false }],
          extraColumns: [],
          typeDiffs: [],
          nullableDiffs: [],
          defaultDiffs: [],
        },
      ],
      indexDiffs: [
        {
          table: "favorites",
          missingIndexes: [],
          extraIndexes: ["idx_favorites_extra"],
          modifiedIndexes: [],
        },
      ],
    },
    checkedAt: new Date().toISOString(),
    summary: { schemaDrifts: 4, identical: false },
    ...overrides,
  };
}

describe("formatTextDiff", () => {
  it("contains expected strings for text format", () => {
    const result = makeDiffResult();
    const output = formatTextDiff(result);

    expect(output).toContain("Environment Diff");
    expect(output).toContain("live_rooms");
    expect(output).toContain("live_viewers");
    expect(output).toContain("kol_applications");
    expect(output).toContain("updated_at");
    expect(output).toContain("idx_favorites_extra");
    expect(output).toContain("NOT in sync");
    expect(output).toContain("4 schema drifts");
  });

  it("shows in sync for identical schemas", () => {
    const result = makeDiffResult({
      schema: { missingTables: [], extraTables: [], columnDiffs: [], indexDiffs: [] },
      summary: { schemaDrifts: 0, identical: true },
    });
    const output = formatTextDiff(result);
    expect(output).toContain("in sync");
    expect(output).toContain("Schemas are identical");
  });

  it("includes health section when health is present", () => {
    const result = makeDiffResult({
      health: {
        source: { score: 89, grade: "B", url: "postgresql://src/db" },
        target: { score: 72, grade: "C", url: "postgresql://tgt/db" },
        sourceOnlyIssues: [],
        targetOnlyIssues: ["warning: idle connections"],
      },
    });
    const output = formatTextDiff(result);
    expect(output).toContain("Health Comparison");
    expect(output).toContain("89/100");
    expect(output).toContain("72/100");
    expect(output).toContain("idle connections");
  });
});

describe("formatMdDiff", () => {
  it("md format output contains markdown table", () => {
    const result = makeDiffResult();
    const output = formatMdDiff(result);

    expect(output).toContain("| Type | Details |");
    expect(output).toContain("|------|---------|");
    expect(output).toContain("❌ Missing tables");
    expect(output).toContain("`live_rooms`");
    expect(output).toContain("❌ Missing columns");
    expect(output).toContain("kol_applications.updated_at");
  });

  it("json format is valid JSON with correct structure", () => {
    const result = makeDiffResult();
    const json = JSON.stringify(result, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("schema");
    expect(parsed).toHaveProperty("summary");
    expect(parsed).toHaveProperty("checkedAt");
    expect(parsed.schema).toHaveProperty("missingTables");
    expect(parsed.schema).toHaveProperty("extraTables");
    expect(parsed.schema).toHaveProperty("columnDiffs");
    expect(parsed.schema).toHaveProperty("indexDiffs");
    expect(parsed.summary).toHaveProperty("schemaDrifts");
    expect(parsed.summary).toHaveProperty("identical");
    expect(Array.isArray(parsed.schema.missingTables)).toBe(true);
  });

  it("shows identical message when no drifts", () => {
    const result = makeDiffResult({
      schema: { missingTables: [], extraTables: [], columnDiffs: [], indexDiffs: [] },
      summary: { schemaDrifts: 0, identical: true },
    });
    const output = formatMdDiff(result);
    expect(output).toContain("✅ Schemas are identical");
  });

  it("shows result summary line", () => {
    const result = makeDiffResult();
    const output = formatMdDiff(result);
    expect(output).toContain("**Result:");
    expect(output).toContain("NOT in sync");
  });
});

// ── New tests: nullable diff, default diff, modified index ────────────────────

describe("diffEnvironments — nullable drift", () => {
  it("detects nullable drift (source NOT NULL, target nullable)", async () => {
    const srcHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "email", "text", "NO")],  // NOT NULL
      []
    );
    const tgtHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "email", "text", "YES")], // nullable
      []
    );

    const result = await runDiff(srcHandler, tgtHandler);

    const diff = result.schema.columnDiffs.find((d) => d.table === "users");
    expect(diff).toBeDefined();
    expect(diff!.nullableDiffs).toHaveLength(1);
    expect(diff!.nullableDiffs[0].column).toBe("email");
    expect(diff!.nullableDiffs[0].sourceNullable).toBe(false);
    expect(diff!.nullableDiffs[0].targetNullable).toBe(true);
    expect(result.summary.schemaDrifts).toBe(1);
    expect(result.summary.identical).toBe(false);
  });

  it("no nullable drift when both are the same", async () => {
    const handler = makeSchemaHandler(
      ["users"],
      [colRow("users", "email", "text", "NO")],
      []
    );

    const result = await runDiff(handler, handler);

    expect(result.summary.identical).toBe(true);
    expect(result.schema.columnDiffs).toHaveLength(0);
  });
});

describe("diffEnvironments — default drift", () => {
  it("detects default drift (different defaults)", async () => {
    const srcHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "created_at", "timestamp", "YES", "now()")],
      []
    );
    const tgtHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "created_at", "timestamp", "YES", null)],
      []
    );

    const result = await runDiff(srcHandler, tgtHandler);

    const diff = result.schema.columnDiffs.find((d) => d.table === "users");
    expect(diff).toBeDefined();
    expect(diff!.defaultDiffs).toHaveLength(1);
    expect(diff!.defaultDiffs[0].column).toBe("created_at");
    expect(diff!.defaultDiffs[0].sourceDefault).toBe("now()");
    expect(diff!.defaultDiffs[0].targetDefault).toBeNull();
    expect(result.summary.schemaDrifts).toBe(1);
  });

  it("no default drift when both columns have the same default", async () => {
    const handler = makeSchemaHandler(
      ["users"],
      [colRow("users", "created_at", "timestamp", "YES", "now()")],
      []
    );

    const result = await runDiff(handler, handler);

    expect(result.summary.identical).toBe(true);
    expect(result.schema.columnDiffs).toHaveLength(0);
  });
});

describe("diffEnvironments — modified index (same name, different definition)", () => {
  it("detects modified index when definitions differ", async () => {
    const srcHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint")],
      [idxRow("users", "idx_users_email", "CREATE INDEX idx_users_email ON users (email)")]
    );
    const tgtHandler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint")],
      [idxRow("users", "idx_users_email", "CREATE INDEX idx_users_email ON users (email, created_at)")]
    );

    const result = await runDiff(srcHandler, tgtHandler);

    expect(result.schema.indexDiffs).toHaveLength(1);
    const idxDiff = result.schema.indexDiffs[0];
    expect(idxDiff.modifiedIndexes).toHaveLength(1);
    expect(idxDiff.modifiedIndexes[0].name).toBe("idx_users_email");
    expect(idxDiff.modifiedIndexes[0].sourceDef).toBe("CREATE INDEX idx_users_email ON users (email)");
    expect(idxDiff.modifiedIndexes[0].targetDef).toBe("CREATE INDEX idx_users_email ON users (email, created_at)");
    expect(result.summary.schemaDrifts).toBe(1);
    expect(result.summary.identical).toBe(false);
  });

  it("modifiedIndexes count is included in schemaDrifts", async () => {
    const srcHandler = makeSchemaHandler(
      ["orders"],
      [colRow("orders", "id", "bigint")],
      [
        idxRow("orders", "idx_orders_a", "CREATE INDEX idx_orders_a ON orders (a)"),
        idxRow("orders", "idx_orders_b", "CREATE INDEX idx_orders_b ON orders (b)"),
      ]
    );
    const tgtHandler = makeSchemaHandler(
      ["orders"],
      [colRow("orders", "id", "bigint")],
      [
        idxRow("orders", "idx_orders_a", "CREATE INDEX idx_orders_a ON orders (a, b)"), // modified
        idxRow("orders", "idx_orders_b", "CREATE INDEX idx_orders_b ON orders (b)"),    // same
      ]
    );

    const result = await runDiff(srcHandler, tgtHandler);

    expect(result.summary.schemaDrifts).toBe(1); // only idx_orders_a
    const idxDiff = result.schema.indexDiffs.find((d) => d.table === "orders");
    expect(idxDiff!.modifiedIndexes).toHaveLength(1);
    expect(idxDiff!.missingIndexes).toHaveLength(0);
    expect(idxDiff!.extraIndexes).toHaveLength(0);
  });

  it("no modified indexes when definitions are identical", async () => {
    const def = "CREATE INDEX idx_users_email ON users (email)";
    const handler = makeSchemaHandler(
      ["users"],
      [colRow("users", "id", "bigint")],
      [idxRow("users", "idx_users_email", def)]
    );

    const result = await runDiff(handler, handler);

    expect(result.summary.identical).toBe(true);
    expect(result.schema.indexDiffs).toHaveLength(0);
  });
});
