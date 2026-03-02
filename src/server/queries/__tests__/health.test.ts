import { describe, it, expect } from "vitest";
import { computeScore, type HealthIssue } from "../health.js";

describe("computeScore", () => {
  it("returns 100 for no issues", () => {
    expect(computeScore([])).toBe(100);
  });

  it("deducts 15 for critical issues", () => {
    const issues: HealthIssue[] = [
      { severity: "critical", check: "test", description: "bad" },
    ];
    expect(computeScore(issues)).toBe(85);
  });

  it("deducts 7 for warning issues", () => {
    const issues: HealthIssue[] = [
      { severity: "warning", check: "test", description: "meh" },
    ];
    expect(computeScore(issues)).toBe(93);
  });

  it("deducts 2 for info issues", () => {
    const issues: HealthIssue[] = [
      { severity: "info", check: "test", description: "fyi" },
    ];
    expect(computeScore(issues)).toBe(98);
  });

  it("clamps at 0", () => {
    const issues: HealthIssue[] = Array.from({ length: 20 }, () => ({
      severity: "critical" as const,
      check: "test",
      description: "bad",
    }));
    expect(computeScore(issues)).toBe(0);
  });

  it("handles mixed severities", () => {
    const issues: HealthIssue[] = [
      { severity: "critical", check: "a", description: "" },
      { severity: "warning", check: "b", description: "" },
      { severity: "info", check: "c", description: "" },
    ];
    // 100 - 15 - 7 - 2 = 76
    expect(computeScore(issues)).toBe(76);
  });

  it("grade boundaries via score", () => {
    // Test via the scoring - grades are derived from score
    expect(computeScore([])).toBeGreaterThanOrEqual(90); // A
    const twoWarnings: HealthIssue[] = [
      { severity: "warning", check: "a", description: "" },
      { severity: "warning", check: "b", description: "" },
    ];
    expect(computeScore(twoWarnings)).toBe(86); // B
  });
});
