import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSnapshot, loadSnapshot, diffSnapshots } from "../snapshot.js";
import type { AdvisorResult, AdvisorIssue } from "../advisor.js";

function tmpPath() {
  const d = path.join(os.tmpdir(), `pg-dash-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return path.join(d, "last-check.json");
}

function makeResult(score: number, issues: Partial<AdvisorIssue>[] = []): AdvisorResult {
  return {
    score,
    grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 50 ? "D" : "F",
    issues: issues.map((i, idx) => ({
      id: `issue-${idx}`,
      severity: "warning" as const,
      category: "performance" as const,
      title: `Issue ${idx}`,
      description: "",
      fix: "",
      impact: "",
      effort: "quick" as const,
      ...i,
    })),
    breakdown: {},
    batchFixes: [],
    ignoredCount: 0,
    skipped: [],
  };
}

describe("saveSnapshot / loadSnapshot", () => {
  it("saves and loads a snapshot", () => {
    const p = tmpPath();
    const result = makeResult(85);
    saveSnapshot(p, result);
    const loaded = loadSnapshot(p);
    expect(loaded).not.toBeNull();
    expect(loaded!.result.score).toBe(85);
    expect(loaded!.timestamp).toBeTruthy();
  });

  it("returns null for missing file", () => {
    expect(loadSnapshot("/tmp/does-not-exist-pg-dash.json")).toBeNull();
  });

  it("returns null for corrupt file", () => {
    const p = tmpPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not valid json");
    expect(loadSnapshot(p)).toBeNull();
  });

  it("creates parent directories automatically", () => {
    const p = path.join(os.tmpdir(), `pg-dash-snap-deep-${Date.now()}`, "nested", "dir", "snap.json");
    saveSnapshot(p, makeResult(90));
    expect(fs.existsSync(p)).toBe(true);
  });
});

describe("diffSnapshots", () => {
  it("detects new issues", () => {
    const prev = makeResult(90, []);
    const curr = makeResult(80, [{ id: "perf-seq-scan-users", title: "Seq scan on users" }]);
    const diff = diffSnapshots(prev, curr);
    expect(diff.newIssues).toHaveLength(1);
    expect(diff.newIssues[0].id).toBe("perf-seq-scan-users");
    expect(diff.resolvedIssues).toHaveLength(0);
    expect(diff.scoreDelta).toBe(-10);
  });

  it("detects resolved issues", () => {
    const prev = makeResult(80, [{ id: "perf-seq-scan-users", title: "Seq scan on users" }]);
    const curr = makeResult(95, []);
    const diff = diffSnapshots(prev, curr);
    expect(diff.resolvedIssues).toHaveLength(1);
    expect(diff.newIssues).toHaveLength(0);
    expect(diff.scoreDelta).toBe(15);
  });

  it("normalizes dynamic IDs — idle-in-transaction PID changes don't cause noise", () => {
    // Simulate idle-in-transaction issue with PID that changes between runs
    const prev = makeResult(80, [{ id: "maint-idle-tx-12345", title: "Idle-in-transaction connection PID 12345" }]);
    const curr = makeResult(80, [{ id: "maint-idle-tx-99999", title: "Idle-in-transaction connection PID 99999" }]);
    const diff = diffSnapshots(prev, curr);
    // Should be treated as unchanged, not new+resolved
    expect(diff.newIssues).toHaveLength(0);
    expect(diff.resolvedIssues).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
  });

  it("detects unchanged issues", () => {
    const issue = { id: "schema-missing-fk-index-users-org_id", title: "Missing FK index" };
    const prev = makeResult(85, [issue]);
    const curr = makeResult(85, [issue]);
    const diff = diffSnapshots(prev, curr);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.newIssues).toHaveLength(0);
    expect(diff.resolvedIssues).toHaveLength(0);
  });

  it("handles empty → empty", () => {
    const diff = diffSnapshots(makeResult(100), makeResult(100));
    expect(diff.newIssues).toHaveLength(0);
    expect(diff.resolvedIssues).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.scoreDelta).toBe(0);
  });

  it("handles multiple simultaneous new and resolved", () => {
    const prev = makeResult(75, [
      { id: "perf-seq-scan-users" },
      { id: "schema-missing-fk-index-orders-user_id" },
    ]);
    const curr = makeResult(80, [
      { id: "schema-missing-fk-index-orders-user_id" },
      { id: "maint-vacuum-products" },
    ]);
    const diff = diffSnapshots(prev, curr);
    expect(diff.resolvedIssues.map((i) => i.id)).toContain("perf-seq-scan-users");
    expect(diff.newIssues.map((i) => i.id)).toContain("maint-vacuum-products");
    expect(diff.unchanged.map((i) => i.id)).toContain("schema-missing-fk-index-orders-user_id");
  });

  it("reports correct grade metadata", () => {
    const diff = diffSnapshots(makeResult(70), makeResult(85));
    expect(diff.previousScore).toBe(70);
    expect(diff.currentScore).toBe(85);
    expect(diff.previousGrade).toBe("C");
    expect(diff.currentGrade).toBe("B");
  });
});
