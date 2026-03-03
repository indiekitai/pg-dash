import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { SchemaTracker } from "../schema-tracker.js";

// Mock pg Pool and schema queries
vi.mock("../queries/schema.js", () => ({
  getSchemaTables: vi.fn(),
  getSchemaTableDetail: vi.fn(),
  getSchemaEnums: vi.fn(),
}));

import { getSchemaTables, getSchemaTableDetail, getSchemaEnums } from "../queries/schema.js";

const mockGetSchemaTables = vi.mocked(getSchemaTables);
const mockGetSchemaTableDetail = vi.mocked(getSchemaTableDetail);
const mockGetSchemaEnums = vi.mocked(getSchemaEnums);

function makeMockPool(): any {
  return {};
}

describe("SchemaTracker", () => {
  let db: Database.Database;
  let tracker: SchemaTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    tracker = new SchemaTracker(db, makeMockPool(), 999999999);
    vi.clearAllMocks();
  });

  afterEach(() => {
    tracker.stop();
    db.close();
  });

  function setupMockSchema(tables: any[], enums: any[] = []) {
    mockGetSchemaTables.mockResolvedValue(tables.map((t) => ({ schema: t.schema, name: t.name })));
    for (const t of tables) {
      mockGetSchemaTableDetail.mockImplementation(async (_pool: any, fullName: string) => {
        const found = tables.find((tb: any) => `${tb.schema}.${tb.name}` === fullName);
        return found || null;
      });
    }
    mockGetSchemaEnums.mockResolvedValue(enums);
  }

  it("takes a snapshot and stores it", async () => {
    setupMockSchema([
      {
        schema: "public", name: "users",
        columns: [{ name: "id", type: "integer", nullable: false, default_value: null }],
        indexes: [], constraints: [],
      },
    ]);

    const result = await tracker.takeSnapshot();
    expect(result.snapshotId).toBe(1);
    expect(result.changes).toEqual([]); // First snapshot has no previous to diff

    const history = tracker.getHistory();
    expect(history).toHaveLength(1);
  });

  it("detects added table between snapshots", async () => {
    // First snapshot: one table
    setupMockSchema([
      {
        schema: "public", name: "users",
        columns: [{ name: "id", type: "integer", nullable: false, default_value: null }],
        indexes: [], constraints: [],
      },
    ]);
    await tracker.takeSnapshot();

    // Second snapshot: two tables
    setupMockSchema([
      {
        schema: "public", name: "users",
        columns: [{ name: "id", type: "integer", nullable: false, default_value: null }],
        indexes: [], constraints: [],
      },
      {
        schema: "public", name: "posts",
        columns: [{ name: "id", type: "integer", nullable: false, default_value: null }],
        indexes: [], constraints: [],
      },
    ]);
    const result = await tracker.takeSnapshot();
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.some((c) => c.change_type === "added" && c.object_type === "table")).toBe(true);
  });

  it("detects removed column between snapshots", async () => {
    setupMockSchema([
      {
        schema: "public", name: "users",
        columns: [
          { name: "id", type: "integer", nullable: false, default_value: null },
          { name: "email", type: "text", nullable: true, default_value: null },
        ],
        indexes: [], constraints: [],
      },
    ]);
    await tracker.takeSnapshot();

    setupMockSchema([
      {
        schema: "public", name: "users",
        columns: [{ name: "id", type: "integer", nullable: false, default_value: null }],
        indexes: [], constraints: [],
      },
    ]);
    const result = await tracker.takeSnapshot();
    expect(result.changes.some((c) => c.change_type === "removed" && c.object_type === "column")).toBe(true);
  });

  it("getHistory returns snapshots", async () => {
    setupMockSchema([{
      schema: "public", name: "t",
      columns: [], indexes: [], constraints: [],
    }]);
    await tracker.takeSnapshot();
    await tracker.takeSnapshot();
    const history = tracker.getHistory(10);
    expect(history).toHaveLength(2);
  });

  it("getChanges returns changes", async () => {
    setupMockSchema([{
      schema: "public", name: "t",
      columns: [{ name: "a", type: "int", nullable: false, default_value: null }],
      indexes: [], constraints: [],
    }]);
    await tracker.takeSnapshot();

    setupMockSchema([{
      schema: "public", name: "t",
      columns: [
        { name: "a", type: "int", nullable: false, default_value: null },
        { name: "b", type: "text", nullable: true, default_value: null },
      ],
      indexes: [], constraints: [],
    }]);
    await tracker.takeSnapshot();

    const changes = tracker.getChanges();
    expect(changes.length).toBeGreaterThan(0);
  });

  it("getDiff compares two snapshots", async () => {
    setupMockSchema([{
      schema: "public", name: "t",
      columns: [{ name: "a", type: "int", nullable: false, default_value: null }],
      indexes: [], constraints: [],
    }]);
    const s1 = await tracker.takeSnapshot();

    setupMockSchema([{
      schema: "public", name: "t",
      columns: [{ name: "a", type: "bigint", nullable: false, default_value: null }],
      indexes: [], constraints: [],
    }]);
    const s2 = await tracker.takeSnapshot();

    const diff = tracker.getDiff(s1.snapshotId, s2.snapshotId);
    expect(diff).not.toBeNull();
    expect(diff!.some((c) => c.change_type === "modified" && c.detail.includes("type changed"))).toBe(true);
  });

  it("getDiff returns null for missing snapshots", () => {
    expect(tracker.getDiff(999, 1000)).toBeNull();
  });

  it("getLatestChanges returns empty when no snapshots", () => {
    expect(tracker.getLatestChanges()).toEqual([]);
  });
});
