import type { TimeseriesStore } from "./timeseries.js";

export interface DiskPrediction {
  currentBytes: number;
  growthRatePerDay: number;
  predictedFullDate: Date | null;
  daysUntilFull: number | null;
  confidence: number;
}

/**
 * Simple linear regression: y = mx + b
 * Returns { slope, intercept, r2 }
 */
export function linearRegression(points: { x: number; y: number }[]): { slope: number; intercept: number; r2: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
    sumY2 += p.y * p.y;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R² calculation
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    ssTot += (p.y - meanY) ** 2;
    ssRes += (p.y - (slope * p.x + intercept)) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  return { slope, intercept, r2 };
}

export class DiskPredictor {
  /**
   * Predict disk growth based on historical metric data.
   * @param store TimeseriesStore instance
   * @param metric Metric name (e.g. "db_size_bytes")
   * @param daysAhead How many days to project ahead
   * @param maxDiskBytes Optional max disk capacity for "days until full" calc
   */
  predict(store: TimeseriesStore, metric: string, daysAhead: number, maxDiskBytes?: number): DiskPrediction | null {
    const now = Date.now();
    // Get all available data (up to 30 days)
    const data = store.query(metric, now - 30 * 24 * 60 * 60 * 1000, now);

    if (data.length < 2) return null;

    // Need at least 24 hours of data
    const timeSpanMs = data[data.length - 1].timestamp - data[0].timestamp;
    if (timeSpanMs < 24 * 60 * 60 * 1000) return null;

    const currentBytes = data[data.length - 1].value;

    // Normalize timestamps to days from first point
    const t0 = data[0].timestamp;
    const points = data.map(d => ({
      x: (d.timestamp - t0) / (24 * 60 * 60 * 1000), // days
      y: d.value,
    }));

    const { slope, r2 } = linearRegression(points);
    const growthRatePerDay = slope; // bytes per day

    let predictedFullDate: Date | null = null;
    let daysUntilFull: number | null = null;

    if (maxDiskBytes && growthRatePerDay > 0) {
      const remainingBytes = maxDiskBytes - currentBytes;
      daysUntilFull = remainingBytes / growthRatePerDay;
      if (daysUntilFull > 0 && daysUntilFull < 365 * 10) {
        predictedFullDate = new Date(now + daysUntilFull * 24 * 60 * 60 * 1000);
      }
    }

    return {
      currentBytes,
      growthRatePerDay,
      predictedFullDate,
      daysUntilFull: daysUntilFull !== null && daysUntilFull > 0 ? daysUntilFull : null,
      confidence: r2,
    };
  }
}
