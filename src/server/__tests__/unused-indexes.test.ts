import { describe, it, expect, vi } from "vitest";
import { getUnusedIndexes, formatBytes } from "../unused-indexes.js";

function makePool(rows: any[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe("getUnusedIndexes", () => {
  it("returns empty report when no unused indexes", async () => {
    const pool = makePool([]);
    const report = await getUnusedIndexes(pool as any);
    expect(report.indexes).toHaveLength(0);
    expect(report.totalWastedBytes).toBe(0);
  });

  it("correctly calculates totalWastedBytes", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "orders", index_name: "idx_orders_old", index_size_bytes: "2097152", idx_scan: "0", indexdef: "CREATE INDEX idx_orders_old ON public.orders" },
      { schemaname: "public", table_name: "users", index_name: "idx_users_old", index_size_bytes: "1048576", idx_scan: "0", indexdef: "CREATE INDEX idx_users_old ON public.users" },
    ]);
    const report = await getUnusedIndexes(pool as any);
    expect(report.totalWastedBytes).toBe(2097152 + 1048576);
  });

  it("formats bytes: < 1 KB for small values", () => {
    expect(formatBytes(0)).toBe("< 1 KB");
    expect(formatBytes(512)).toBe("< 1 KB");
    expect(formatBytes(1023)).toBe("< 1 KB");
  });

  it("formats bytes: KB range", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
  });

  it("formats bytes: MB range", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(2.4 * 1024 * 1024)).toBe("2.4 MB");
  });

  it("formats bytes: GB range", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("returns indexes sorted by size DESC (as returned by query)", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "orders", index_name: "idx_big", index_size_bytes: "5000000", idx_scan: "0", indexdef: "CREATE INDEX idx_big ON public.orders" },
      { schemaname: "public", table_name: "users", index_name: "idx_small", index_size_bytes: "100000", idx_scan: "0", indexdef: "CREATE INDEX idx_small ON public.users" },
    ]);
    const report = await getUnusedIndexes(pool as any);
    expect(report.indexes[0].index).toBe("idx_big");
    expect(report.indexes[1].index).toBe("idx_small");
  });

  it("builds correct suggestion message", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "orders", index_name: "idx_orders_x", index_size_bytes: "1024", idx_scan: "0", indexdef: "CREATE INDEX idx_orders_x ON public.orders" },
    ]);
    const report = await getUnusedIndexes(pool as any);
    expect(report.indexes[0].suggestion).toContain("DROP INDEX CONCURRENTLY idx_orders_x");
    expect(report.indexes[0].suggestion).toContain("0 scans");
  });

  it("maps schema, table, index, scans correctly", async () => {
    const pool = makePool([
      { schemaname: "public", table_name: "products", index_name: "idx_products_sku", index_size_bytes: "65536", idx_scan: "0", indexdef: "CREATE INDEX idx_products_sku ON public.products (sku)" },
    ]);
    const report = await getUnusedIndexes(pool as any);
    const idx = report.indexes[0];
    expect(idx.schema).toBe("public");
    expect(idx.table).toBe("products");
    expect(idx.index).toBe("idx_products_sku");
    expect(idx.scans).toBe(0);
    expect(idx.lastUsed).toBeNull();
  });
});
