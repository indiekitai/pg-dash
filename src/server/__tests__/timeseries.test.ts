import { describe, it, expect, afterEach } from "vitest";
import { TimeseriesStore } from "../timeseries.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDir() {
  const d = path.join(os.tmpdir(), `pg-dash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("TimeseriesStore", () => {
  let store: TimeseriesStore;
  let dir: string;

  afterEach(() => {
    store?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and queries data points", () => {
    dir = tmpDir();
    store = new TimeseriesStore(dir);
    const now = Date.now();
    store.insert("tps_commit", 42, now - 5000);
    store.insert("tps_commit", 50, now);
    store.insert("cache_hit_ratio", 0.99, now);

    const results = store.query("tps_commit", now - 10000, now);
    expect(results).toHaveLength(2);
    expect(results[0].value).toBe(42);
    expect(results[1].value).toBe(50);
  });

  it("insertMany works in transaction", () => {
    dir = tmpDir();
    store = new TimeseriesStore(dir);
    const now = Date.now();
    store.insertMany([
      { timestamp: now, metric: "a", value: 1 },
      { timestamp: now, metric: "b", value: 2 },
      { timestamp: now + 1000, metric: "a", value: 3 },
    ]);

    expect(store.query("a", now - 1000, now + 2000)).toHaveLength(2);
    expect(store.query("b", now - 1000, now + 2000)).toHaveLength(1);
  });

  it("query respects time range", () => {
    dir = tmpDir();
    store = new TimeseriesStore(dir);
    const now = Date.now();
    store.insert("m", 1, now - 60000);
    store.insert("m", 2, now - 30000);
    store.insert("m", 3, now);

    const results = store.query("m", now - 45000, now - 15000);
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(2);
  });

  it("prune removes old data", () => {
    dir = tmpDir();
    store = new TimeseriesStore(dir, 0); // 0 days retention = prune everything
    const now = Date.now();
    store.insert("m", 1, now - 1000);
    const removed = store.prune();
    expect(removed).toBe(1);
    expect(store.query("m", 0, now)).toHaveLength(0);
  });

  it("latest returns most recent values", () => {
    dir = tmpDir();
    store = new TimeseriesStore(dir);
    const now = Date.now();
    store.insert("a", 10, now - 2000);
    store.insert("a", 20, now);
    store.insert("b", 5, now);

    const latest = store.latest();
    expect(latest.a.value).toBe(20);
    expect(latest.b.value).toBe(5);
  });
});
