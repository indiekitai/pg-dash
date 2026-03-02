import { describe, it, expect } from "vitest";
import { computeAdvisorScore, gradeFromScore, isSafeFix, type AdvisorIssue } from "../advisor.js";

function issue(severity: AdvisorIssue["severity"], category: AdvisorIssue["category"] = "performance"): AdvisorIssue {
  return { id: `test-${Math.random()}`, severity, category, title: "test", description: "test", fix: "SELECT 1", impact: "test", effort: "quick" };
}

describe("computeAdvisorScore", () => {
  it("returns 100 for no issues", () => {
    expect(computeAdvisorScore([])).toBe(100);
  });

  it("deducts 20 for critical", () => {
    expect(computeAdvisorScore([issue("critical")])).toBe(80);
  });

  it("deducts 8 for warning", () => {
    expect(computeAdvisorScore([issue("warning")])).toBe(92);
  });

  it("deducts 3 for info", () => {
    expect(computeAdvisorScore([issue("info")])).toBe(97);
  });

  it("clamps at 0 with many issues", () => {
    const issues = Array.from({ length: 20 }, () => issue("critical"));
    expect(computeAdvisorScore(issues)).toBe(0);
  });

  it("handles mixed severities", () => {
    // 100 - 20 - 8 - 3 = 69
    expect(computeAdvisorScore([issue("critical"), issue("warning"), issue("info")])).toBe(69);
  });

  it("applies diminishing penalty for many issues of same severity", () => {
    // 10 warnings: first 5 at 8 = 40, next 5 at 4 = 20 => 100 - 60 = 40
    const issues = Array.from({ length: 10 }, () => issue("warning"));
    expect(computeAdvisorScore(issues)).toBe(40);
  });
});

describe("gradeFromScore", () => {
  it("A for 90+", () => expect(gradeFromScore(95)).toBe("A"));
  it("A for exactly 90", () => expect(gradeFromScore(90)).toBe("A"));
  it("B for 80-89", () => expect(gradeFromScore(85)).toBe("B"));
  it("C for 70-79", () => expect(gradeFromScore(75)).toBe("C"));
  it("D for 50-69", () => expect(gradeFromScore(60)).toBe("D"));
  it("F for <50", () => expect(gradeFromScore(30)).toBe("F"));
  it("F for 0", () => expect(gradeFromScore(0)).toBe("F"));
});

describe("isSafeFix", () => {
  it("allows VACUUM", () => expect(isSafeFix("VACUUM ANALYZE public.users;")).toBe(true));
  it("allows ANALYZE", () => expect(isSafeFix("ANALYZE public.users;")).toBe(true));
  it("allows REINDEX", () => expect(isSafeFix("REINDEX INDEX CONCURRENTLY idx_users_email;")).toBe(true));
  it("allows CREATE INDEX CONCURRENTLY", () => expect(isSafeFix("CREATE INDEX CONCURRENTLY idx_test ON t(c);")).toBe(true));
  it("allows DROP INDEX CONCURRENTLY", () => expect(isSafeFix("DROP INDEX CONCURRENTLY idx_test;")).toBe(true));
  it("allows pg_terminate_backend", () => expect(isSafeFix("SELECT pg_terminate_backend(123);")).toBe(true));
  it("allows pg_cancel_backend", () => expect(isSafeFix("SELECT pg_cancel_backend(123);")).toBe(true));
  it("allows EXPLAIN ANALYZE", () => expect(isSafeFix("EXPLAIN ANALYZE SELECT * FROM users;")).toBe(true));
  it("rejects DROP TABLE", () => expect(isSafeFix("DROP TABLE users;")).toBe(false));
  it("rejects DELETE", () => expect(isSafeFix("DELETE FROM users;")).toBe(false));
  it("rejects ALTER TABLE", () => expect(isSafeFix("ALTER TABLE users DROP COLUMN email;")).toBe(false));
  it("rejects SELECT (non pg_terminate)", () => expect(isSafeFix("SELECT * FROM users;")).toBe(false));
  it("case insensitive", () => expect(isSafeFix("vacuum analyze t;")).toBe(true));
  it("rejects empty", () => expect(isSafeFix("")).toBe(false));
});
