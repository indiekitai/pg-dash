import { describe, it, expect } from "vitest";
import { computeAdvisorScore, gradeFromScore, type AdvisorIssue } from "../../advisor.js";

function issue(severity: AdvisorIssue["severity"]): AdvisorIssue {
  return { id: `test-${Math.random()}`, severity, category: "performance", title: "test", description: "test", fix: "SELECT 1", impact: "test", effort: "quick" };
}

describe("computeAdvisorScore (from health.test migration)", () => {
  it("returns 100 for no issues", () => {
    expect(computeAdvisorScore([])).toBe(100);
  });

  it("deducts for critical issues", () => {
    expect(computeAdvisorScore([issue("critical")])).toBe(80);
  });

  it("deducts for warning issues", () => {
    expect(computeAdvisorScore([issue("warning")])).toBe(92);
  });

  it("deducts for info issues", () => {
    expect(computeAdvisorScore([issue("info")])).toBe(97);
  });

  it("clamps at 0", () => {
    const issues = Array.from({ length: 20 }, () => issue("critical"));
    expect(computeAdvisorScore(issues)).toBe(0);
  });

  it("handles mixed severities", () => {
    const result = computeAdvisorScore([issue("critical"), issue("warning"), issue("info")]);
    // 100 - 20 - 8 - 3 = 69
    expect(result).toBe(69);
  });

  it("grade boundaries via score", () => {
    expect(gradeFromScore(95)).toBe("A");
    expect(gradeFromScore(85)).toBe("B");
    expect(gradeFromScore(75)).toBe("C");
    expect(gradeFromScore(60)).toBe("D");
    expect(gradeFromScore(30)).toBe("F");
  });
});
