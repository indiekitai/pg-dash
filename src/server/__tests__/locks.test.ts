import { describe, it, expect, vi } from "vitest";
import { getLockReport, formatDurationSecs } from "../locks.js";

function makePool(lockRows: any[], longRows: any[]) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: lockRows })
    .mockResolvedValueOnce({ rows: longRows });
  return { query };
}

describe("formatDurationSecs", () => {
  it("formats 0 seconds", () => {
    expect(formatDurationSecs(0)).toBe("00:00:00");
  });

  it("formats 65 seconds → 00:01:05", () => {
    expect(formatDurationSecs(65)).toBe("00:01:05");
  });

  it("formats 3661 seconds → 01:01:01", () => {
    expect(formatDurationSecs(3661)).toBe("01:01:01");
  });

  it("formats 45 seconds → 00:00:45", () => {
    expect(formatDurationSecs(45)).toBe("00:00:45");
  });

  it("formats 3600 seconds → 01:00:00", () => {
    expect(formatDurationSecs(3600)).toBe("01:00:00");
  });
});

describe("getLockReport", () => {
  it("returns empty waitingLocks when no locks", async () => {
    const pool = makePool([], []);
    const report = await getLockReport(pool as any);
    expect(report.waitingLocks).toHaveLength(0);
    expect(report.longRunningQueries).toHaveLength(0);
  });

  it("correctly maps blocked/blocking pids and queries", async () => {
    const pool = makePool([
      {
        blocked_pid: "100",
        blocked_query: "SELECT * FROM orders FOR UPDATE",
        blocked_secs: "45",
        blocking_pid: "200",
        blocking_query: "UPDATE orders SET status = 1 WHERE id = 5",
        blocking_secs: "90",
        table_name: "orders",
        locktype: "relation",
      },
    ], []);
    const report = await getLockReport(pool as any);
    expect(report.waitingLocks).toHaveLength(1);
    const lock = report.waitingLocks[0];
    expect(lock.blockedPid).toBe(100);
    expect(lock.blockingPid).toBe(200);
    expect(lock.blockedQuery).toBe("SELECT * FROM orders FOR UPDATE");
    expect(lock.blockingQuery).toBe("UPDATE orders SET status = 1 WHERE id = 5");
    expect(lock.blockedDuration).toBe("00:00:45");
    expect(lock.blockingDuration).toBe("00:01:30");
    expect(lock.table).toBe("orders");
    expect(lock.lockType).toBe("relation");
  });

  it("handles null table_name gracefully", async () => {
    const pool = makePool([
      {
        blocked_pid: "101",
        blocked_query: "SELECT 1",
        blocked_secs: "10",
        blocking_pid: "201",
        blocking_query: "SELECT 2",
        blocking_secs: "20",
        table_name: null,
        locktype: "transactionid",
      },
    ], []);
    const report = await getLockReport(pool as any);
    expect(report.waitingLocks[0].table).toBeNull();
  });

  it("maps long-running queries with duration > 5s", async () => {
    const pool = makePool([], [
      { pid: "300", duration_secs: "120", query: "SELECT heavy()", state: "active", wait_event_type: null },
      { pid: "301", duration_secs: "6", query: "SELECT light()", state: "active", wait_event_type: "Lock" },
    ]);
    const report = await getLockReport(pool as any);
    expect(report.longRunningQueries).toHaveLength(2);
    expect(report.longRunningQueries[0].pid).toBe(300);
    expect(report.longRunningQueries[0].duration).toBe("00:02:00");
    expect(report.longRunningQueries[1].waitEventType).toBe("Lock");
  });

  it("long-running queries with null waitEventType are handled", async () => {
    const pool = makePool([], [
      { pid: "302", duration_secs: "30", query: "SELECT pg_sleep(30)", state: "active", wait_event_type: null },
    ]);
    const report = await getLockReport(pool as any);
    expect(report.longRunningQueries[0].waitEventType).toBeNull();
  });

  it("includes checkedAt as ISO string", async () => {
    const pool = makePool([], []);
    const report = await getLockReport(pool as any);
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
