import { describe, it, expect, vi, beforeEach } from "vitest";
import { Collector } from "../collector.js";

// Mock Pool
function mockPool(rows: Record<string, any>) {
  const client = {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("pg_stat_activity")) {
        return { rows: [rows.connections || { active: 5, idle: 10, total: 15 }] };
      }
      if (sql.includes("pg_stat_database")) {
        return {
          rows: [rows.dbStats || {
            xact_commit: "1000", xact_rollback: "10",
            deadlocks: "0", temp_bytes: "0",
            tup_inserted: "500", tup_updated: "200", tup_deleted: "50",
            cache_ratio: "0.995", db_size: "1073741824",
          }],
        };
      }
      if (sql.includes("pg_is_in_recovery")) {
        return { rows: [{ lag_bytes: "0" }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn().mockResolvedValue(client) } as any;
}

// Mock store
function mockStore() {
  return {
    insertMany: vi.fn(),
    prune: vi.fn(),
  } as any;
}

describe("Collector", () => {
  it("collects connection metrics", async () => {
    const pool = mockPool({ connections: { active: 3, idle: 7, total: 10 } });
    const store = mockStore();
    const collector = new Collector(pool, store);

    const snapshot = await collector.collect();
    expect(snapshot.connections_active).toBe(3);
    expect(snapshot.connections_idle).toBe(7);
    expect(snapshot.connections_total).toBe(10);
    expect(store.insertMany).toHaveBeenCalled();
  });

  it("calculates deltas on second collect", async () => {
    let dbQueryCount = 0;
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("pg_stat_activity")) {
          return { rows: [{ active: 5, idle: 10, total: 15 }] };
        }
        if (sql.includes("pg_stat_database")) {
          dbQueryCount++;
          const isSecond = dbQueryCount > 1;
          return {
            rows: [isSecond ? {
              xact_commit: "1100", xact_rollback: "15",
              deadlocks: "1", temp_bytes: "1024",
              tup_inserted: "600", tup_updated: "250", tup_deleted: "60",
              cache_ratio: "0.99", db_size: "1073741824",
            } : {
              xact_commit: "1000", xact_rollback: "10",
              deadlocks: "0", temp_bytes: "0",
              tup_inserted: "500", tup_updated: "200", tup_deleted: "50",
              cache_ratio: "0.995", db_size: "1073741824",
            }],
          };
        }
        if (sql.includes("pg_is_in_recovery")) {
          return { rows: [{ lag_bytes: "0" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as any;
    const store = mockStore();
    const collector = new Collector(pool, store, 1000);

    // First collect establishes baseline
    const origNow = Date.now;
    let fakeTime = 1000000;
    Date.now = () => fakeTime;
    await collector.collect();
    expect(collector.getLastSnapshot().tps_commit).toBeUndefined();

    fakeTime += 30000; // advance 30 seconds
    const snapshot2 = await collector.collect();
    Date.now = origNow;
    // Delta-based metrics should now exist
    expect(snapshot2.tps_commit).toBeGreaterThan(0);
    expect(snapshot2.tps_rollback).toBeGreaterThan(0);
    expect(snapshot2.deadlocks).toBe(1);
  });

  it("getLastSnapshot returns copy", async () => {
    const pool = mockPool({});
    const store = mockStore();
    const collector = new Collector(pool, store);

    await collector.collect();
    const snap = collector.getLastSnapshot();
    snap.connections_active = 9999;
    expect(collector.getLastSnapshot().connections_active).not.toBe(9999);
  });
});
