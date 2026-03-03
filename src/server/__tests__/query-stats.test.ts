import { describe, it, expect, afterEach } from "vitest";
import { QueryStatsStore } from "../query-stats.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDir() {
  const d = path.join(os.tmpdir(), `pg-dash-qs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("QueryStatsStore", () => {
  let store: QueryStatsStore;
  let dir: string;

  afterEach(() => {
    store?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("insertRow stores data and getTrend retrieves it", () => {
    dir = tmpDir();
    store = new QueryStatsStore(dir);
    const now = Date.now();

    store.insertRow({
      timestamp: now - 5000,
      queryid: "123",
      query: "SELECT 1",
      calls: 10,
      total_exec_time: 100,
      mean_exec_time: 10,
      min_exec_time: 1,
      max_exec_time: 50,
      rows: 10,
      shared_blks_hit: 5,
      shared_blks_read: 2,
    });
    store.insertRow({
      timestamp: now,
      queryid: "123",
      query: "SELECT 1",
      calls: 20,
      total_exec_time: 200,
      mean_exec_time: 10,
      min_exec_time: 1,
      max_exec_time: 55,
      rows: 20,
      shared_blks_hit: 10,
      shared_blks_read: 3,
    });

    const trend = store.getTrend("123", now - 10000, now);
    expect(trend).toHaveLength(2);
    expect(trend[0].calls).toBe(10);
    expect(trend[1].calls).toBe(20);
  });

  it("getTrend respects time range", () => {
    dir = tmpDir();
    store = new QueryStatsStore(dir);
    const now = Date.now();

    store.insertRow({ timestamp: now - 60000, queryid: "1", query: "q1", calls: 1, total_exec_time: 10, mean_exec_time: 10, min_exec_time: 1, max_exec_time: 20, rows: 1, shared_blks_hit: 0, shared_blks_read: 0 });
    store.insertRow({ timestamp: now - 30000, queryid: "1", query: "q1", calls: 2, total_exec_time: 20, mean_exec_time: 10, min_exec_time: 1, max_exec_time: 20, rows: 2, shared_blks_hit: 0, shared_blks_read: 0 });
    store.insertRow({ timestamp: now, queryid: "1", query: "q1", calls: 3, total_exec_time: 30, mean_exec_time: 10, min_exec_time: 1, max_exec_time: 20, rows: 3, shared_blks_hit: 0, shared_blks_read: 0 });

    const trend = store.getTrend("1", now - 45000, now - 15000);
    expect(trend).toHaveLength(1);
    expect(trend[0].calls).toBe(2);
  });

  it("getTopQueries orders by total_time", () => {
    dir = tmpDir();
    store = new QueryStatsStore(dir);
    const now = Date.now();

    store.insertRow({ timestamp: now, queryid: "a", query: "fast", calls: 100, total_exec_time: 50, mean_exec_time: 0.5, min_exec_time: 0, max_exec_time: 1, rows: 100, shared_blks_hit: 0, shared_blks_read: 0 });
    store.insertRow({ timestamp: now, queryid: "b", query: "slow", calls: 10, total_exec_time: 5000, mean_exec_time: 500, min_exec_time: 100, max_exec_time: 1000, rows: 10, shared_blks_hit: 0, shared_blks_read: 0 });

    const top = store.getTopQueries(now - 10000, now, "total_time", 10);
    expect(top).toHaveLength(2);
    expect(top[0].queryid).toBe("b");
    expect(top[0].total_exec_time).toBe(5000);
  });

  it("getTopQueries orders by calls", () => {
    dir = tmpDir();
    store = new QueryStatsStore(dir);
    const now = Date.now();

    store.insertRow({ timestamp: now, queryid: "a", query: "many", calls: 1000, total_exec_time: 10, mean_exec_time: 0.01, min_exec_time: 0, max_exec_time: 0.1, rows: 1000, shared_blks_hit: 0, shared_blks_read: 0 });
    store.insertRow({ timestamp: now, queryid: "b", query: "few", calls: 5, total_exec_time: 5000, mean_exec_time: 1000, min_exec_time: 100, max_exec_time: 2000, rows: 5, shared_blks_hit: 0, shared_blks_read: 0 });

    const top = store.getTopQueries(now - 10000, now, "calls", 10);
    expect(top[0].queryid).toBe("a");
    expect(top[0].total_calls).toBe(1000);
  });

  it("getTopQueries orders by mean_time", () => {
    dir = tmpDir();
    store = new QueryStatsStore(dir);
    const now = Date.now();

    store.insertRow({ timestamp: now, queryid: "a", query: "fast", calls: 100, total_exec_time: 50, mean_exec_time: 0.5, min_exec_time: 0, max_exec_time: 1, rows: 100, shared_blks_hit: 0, shared_blks_read: 0 });
    store.insertRow({ timestamp: now, queryid: "b", query: "slow-avg", calls: 10, total_exec_time: 100, mean_exec_time: 500, min_exec_time: 100, max_exec_time: 1000, rows: 10, shared_blks_hit: 0, shared_blks_read: 0 });

    const top = store.getTopQueries(now - 10000, now, "mean_time", 10);
    expect(top[0].queryid).toBe("b");
  });

  it("prune removes old data", () => {
    dir = tmpDir();
    store = new QueryStatsStore(dir, 0); // 0 days retention
    const now = Date.now();

    store.insertRow({ timestamp: now - 1000, queryid: "1", query: "old", calls: 1, total_exec_time: 1, mean_exec_time: 1, min_exec_time: 1, max_exec_time: 1, rows: 1, shared_blks_hit: 0, shared_blks_read: 0 });
    store.insertRow({ timestamp: now + 1000, queryid: "2", query: "new", calls: 1, total_exec_time: 1, mean_exec_time: 1, min_exec_time: 1, max_exec_time: 1, rows: 1, shared_blks_hit: 0, shared_blks_read: 0 });

    const removed = store.prune();
    expect(removed).toBe(1);

    const trend = store.getTrend("1", 0, now + 2000);
    expect(trend).toHaveLength(0);

    const trend2 = store.getTrend("2", 0, now + 2000);
    expect(trend2).toHaveLength(1);
  });

  it("getTopQueries respects limit", () => {
    dir = tmpDir();
    store = new QueryStatsStore(dir);
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      store.insertRow({ timestamp: now, queryid: `q${i}`, query: `query ${i}`, calls: i + 1, total_exec_time: (i + 1) * 100, mean_exec_time: 100, min_exec_time: 1, max_exec_time: 200, rows: i + 1, shared_blks_hit: 0, shared_blks_read: 0 });
    }

    const top = store.getTopQueries(now - 10000, now, "total_time", 3);
    expect(top).toHaveLength(3);
  });
});
