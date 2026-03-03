import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { linearRegression, DiskPredictor } from "../disk-prediction.js";
import { TimeseriesStore } from "../timeseries.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("linearRegression", () => {
  it("computes correct slope and intercept for perfect line", () => {
    // y = 2x + 1
    const points = [
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ];
    const { slope, intercept, r2 } = linearRegression(points);
    expect(slope).toBeCloseTo(2);
    expect(intercept).toBeCloseTo(1);
    expect(r2).toBeCloseTo(1);
  });

  it("returns r2 < 1 for noisy data", () => {
    const points = [
      { x: 0, y: 1 },
      { x: 1, y: 4 },
      { x: 2, y: 3 },
      { x: 3, y: 8 },
      { x: 4, y: 7 },
    ];
    const { r2 } = linearRegression(points);
    expect(r2).toBeGreaterThan(0);
    expect(r2).toBeLessThan(1);
  });

  it("handles single point", () => {
    const { slope, r2 } = linearRegression([{ x: 0, y: 5 }]);
    expect(slope).toBe(0);
    expect(r2).toBe(0);
  });

  it("handles empty array", () => {
    const { slope, r2 } = linearRegression([]);
    expect(slope).toBe(0);
    expect(r2).toBe(0);
  });

  it("handles flat line (all same y)", () => {
    const points = [
      { x: 0, y: 5 },
      { x: 1, y: 5 },
      { x: 2, y: 5 },
    ];
    const { slope, intercept, r2 } = linearRegression(points);
    expect(slope).toBeCloseTo(0);
    expect(intercept).toBeCloseTo(5);
    expect(r2).toBe(1); // Perfect fit for constant
  });
});

describe("DiskPredictor", () => {
  let store: TimeseriesStore;
  let predictor: DiskPredictor;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-dash-test-"));
    store = new TimeseriesStore(tmpDir, 30);
    predictor = new DiskPredictor();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null with insufficient data (< 2 points)", () => {
    store.insert("db_size_bytes", 1000000, Date.now());
    const result = predictor.predict(store, "db_size_bytes", 30);
    expect(result).toBeNull();
  });

  it("returns null with less than 24 hours of data", () => {
    const now = Date.now();
    // 12 hours apart
    store.insert("db_size_bytes", 1000000, now - 12 * 60 * 60 * 1000);
    store.insert("db_size_bytes", 1100000, now);
    const result = predictor.predict(store, "db_size_bytes", 30);
    expect(result).toBeNull();
  });

  it("returns prediction with sufficient data", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    // Growing 1MB per day over 7 days
    for (let i = 0; i < 7; i++) {
      store.insert("db_size_bytes", 1000000 + i * 1000000, now - (7 - i) * dayMs);
    }
    const result = predictor.predict(store, "db_size_bytes", 30);
    expect(result).not.toBeNull();
    expect(result!.currentBytes).toBe(7000000);
    expect(result!.growthRatePerDay).toBeCloseTo(1000000, -3);
    expect(result!.confidence).toBeCloseTo(1, 1);
  });

  it("calculates days until full with maxDiskBytes", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 7; i++) {
      store.insert("db_size_bytes", 1000000 + i * 1000000, now - (7 - i) * dayMs);
    }
    // Current: 7MB, growth: ~1MB/day, max: 10MB → ~3 days until full
    const result = predictor.predict(store, "db_size_bytes", 30, 10000000);
    expect(result).not.toBeNull();
    expect(result!.daysUntilFull).not.toBeNull();
    expect(result!.daysUntilFull!).toBeCloseTo(3, 0);
    expect(result!.predictedFullDate).not.toBeNull();
  });

  it("returns null daysUntilFull when not growing", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    // Flat data
    for (let i = 0; i < 7; i++) {
      store.insert("db_size_bytes", 5000000, now - (7 - i) * dayMs);
    }
    const result = predictor.predict(store, "db_size_bytes", 30, 10000000);
    expect(result).not.toBeNull();
    expect(result!.daysUntilFull).toBeNull();
    expect(result!.growthRatePerDay).toBeCloseTo(0, -2);
  });

  it("returns null daysUntilFull when no maxDiskBytes specified", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 3; i++) {
      store.insert("db_size_bytes", 1000000 + i * 1000000, now - (3 - i) * dayMs);
    }
    const result = predictor.predict(store, "db_size_bytes", 30);
    expect(result).not.toBeNull();
    expect(result!.daysUntilFull).toBeNull();
    expect(result!.predictedFullDate).toBeNull();
  });
});
